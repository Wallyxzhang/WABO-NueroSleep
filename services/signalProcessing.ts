
import { FrequencyBands, AnalysisMetrics, EEGDataPoint } from '../types';
import { MEDITATION_THRESHOLD } from '../constants';

const SCALE_FACTOR = 0.01192; 
const SAMPLE_RATE = 250; 
const FFT_SIZE = 256; 
const FFT_UPDATE_INTERVAL = 25; // 10Hz 更新

const PROTOCOL_START = 0xAA;
const PROTOCOL_END = 0xBB;

function calculateCRC8(data: Uint8Array | number[]): number {
  let crc = 0x00;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x80) {
        crc = ((crc << 1) ^ 0x07) & 0xFF;
      } else {
        crc = (crc << 1) & 0xFF;
      }
    }
  }
  return crc;
}

class SignalProcessor {
    private buffer: number[] = [];
    private prevInput: number | null = null;
    private prevOutput: number = 0;
    private lpfPrev: number = 0; 
    
    // 算法增强：用于平滑最终指标的 EMA 因子
    private smoothRelax: number = 0;
    private lastValidRaw: number | null = null;

    // 针对高偏移量 (36000uV) 的高通滤波器系数
    // 0.99 对应约 0.4Hz 的截止频率，能有效去除直流成分
    private readonly HPF_BETA = 0.992;

    reset() {
        this.buffer = [];
        this.prevInput = null;
        this.prevOutput = 0;
        this.lpfPrev = 0;
        this.smoothRelax = 0;
        this.lastValidRaw = null;
    }

    process(sample: number): { filtered: number, quality: number } {
        // 1. 直流偏移去除 (High Pass Filter)
        // 针对用户提供的 36000uV 左右的原始数据，此处必须过滤掉直流电平
        if (this.prevInput === null) {
            this.prevInput = sample;
            this.prevOutput = 0;
            return { filtered: 0, quality: 1 };
        }

        const hpOutput = sample - this.prevInput + this.HPF_BETA * this.prevOutput;
        this.prevInput = sample;
        this.prevOutput = hpOutput;

        // 2. 低通滤波 (35Hz) 以去除工频干扰和高频肌肉噪声
        const lpOutput = this.lpfPrev + 0.25 * (hpOutput - this.lpfPrev);
        this.lpfPrev = lpOutput;
        
        const finalOutput = lpOutput;
        
        // 3. 更新 FFT 缓冲区
        this.buffer.push(finalOutput);
        if (this.buffer.length > FFT_SIZE) {
            this.buffer.shift();
        }

        // 简易信号质量评估：如果波动异常巨大，质量降低
        const quality = Math.abs(finalOutput) > 400 ? 0.2 : 1.0;

        return { filtered: finalOutput, quality };
    }

    getSmoothedBands(): FrequencyBands | null {
        if (this.buffer.length < FFT_SIZE) return null;

        // 加汉宁窗 (Hanning Window) 减少频谱泄露
        const windowed = this.buffer.map((v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))));
        
        // 极简傅里叶变换
        const mags = new Float32Array(FFT_SIZE / 2);
        for (let k = 0; k < FFT_SIZE / 2; k++) {
             let real = 0; let imag = 0;
             for (let n = 0; n < FFT_SIZE; n++) {
                 const theta = -2 * Math.PI * k * n / FFT_SIZE;
                 real += windowed[n] * Math.cos(theta);
                 imag += windowed[n] * Math.sin(theta);
             }
             mags[k] = (2 * Math.sqrt(real * real + imag * imag)) / FFT_SIZE;
        }
        
        const res = SAMPLE_RATE / FFT_SIZE;
        const getPower = (minHz: number, maxHz: number) => {
            const minBin = Math.floor(minHz / res);
            const maxBin = Math.ceil(maxHz / res);
            let sum = 0;
            for(let i=minBin; i<=maxBin && i < mags.length; i++) sum += mags[i];
            return sum;
        };

        const bands = {
            delta: getPower(1, 4),
            theta: getPower(4, 8),
            alpha: getPower(8, 13),
            beta: getPower(14, 30),
            gamma: getPower(30, 45)
        };

        const total = bands.delta + bands.theta + bands.alpha + bands.beta + bands.gamma + 0.1;
        
        return {
            delta: (bands.delta / total) * 100,
            theta: (bands.theta / total) * 100,
            alpha: (bands.alpha / total) * 100,
            beta:  (bands.beta / total) * 100,
            gamma: (bands.gamma / total) * 100,
        };
    }
}

export class DeviceService {
  private rxChar: any = null; 
  private isConnected: boolean = false;
  private logCallback: ((msg: string) => void) | null = null;
  private rawBuffer: number[] = [];
  private dsp: SignalProcessor = new SignalProcessor();
  private sampleCounter: number = 0;

  private latestData: { 
    raw: EEGDataPoint, 
    bands: FrequencyBands, 
    metrics: AnalysisMetrics 
  } = {
    raw: { timestamp: 0, value: 0 },
    bands: { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 },
    metrics: { attention: 0, relaxation: 0, isMeditating: false, signalQuality: 1.0 }
  };

  private isSimulating: boolean = false;
  private simulationInterval: any = null;

  public setLogger(cb: (msg: string) => void) { this.logCallback = cb; }
  private log(msg: string) { if (this.logCallback) this.logCallback(msg); }
  public getIsConnected() { return this.isConnected || this.isSimulating; }
  public isSimulationMode() { return this.isSimulating; }
  public getDataSnapshot() { return this.latestData; }

  public async connect(): Promise<boolean> {
    if (!(navigator as any).bluetooth) return false;
    try {
      this.dsp.reset();
      const device = await (navigator as any).bluetooth.requestDevice({
        filters: [{ namePrefix: 'SILI' }], 
        optionalServices: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e']
      });
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService('6e400001-b5a3-f393-e0a9-e50e24dcca9e');
      this.rxChar = await service.getCharacteristic('6e400002-b5a3-f393-e0a9-e50e24dcca9e');
      const txChar = await service.getCharacteristic('6e400003-b5a3-f393-e0a9-e50e24dcca9e');
      await txChar.startNotifications();
      txChar.addEventListener('characteristicvaluechanged', (ev: any) => {
          const val = ev.target.value;
          for (let i = 0; i < val.byteLength; i++) this.rawBuffer.push(val.getUint8(i));
          this.processRawBuffer();
      });
      this.isConnected = true;
      // 自动发送启动指令
      await this.sendFrame(0x60, 0x00);
      return true;
    } catch (e: any) {
      this.log(`连接失败: ${e.message}`);
      return false;
    }
  }

  public async sendFrame(func: number, addr: number, data: number[] = []) {
      if (!this.rxChar) return;
      const payload = [func, addr, data.length, ...data];
      const crc = calculateCRC8(payload);
      const packet = new Uint8Array([PROTOCOL_START, ...payload, crc, PROTOCOL_END]);
      await this.rxChar.writeValue(packet);
  }

  public disconnect() {
      this.isConnected = false;
      this.isSimulating = false;
      if (this.simulationInterval) clearInterval(this.simulationInterval);
  }

  private processRawBuffer() {
      while (this.rawBuffer.length >= 7) {
          if (this.rawBuffer[0] !== PROTOCOL_START) { this.rawBuffer.shift(); continue; }
          const len = this.rawBuffer[3];
          const frameSize = 6 + len;
          if (this.rawBuffer.length < frameSize) return;
          if (this.rawBuffer[frameSize-1] !== PROTOCOL_END) { this.rawBuffer.shift(); continue; }
          
          const func = this.rawBuffer[1];
          const payload = this.rawBuffer.slice(4, 4 + len);
          if (func === 0xF0) this.parseADC(payload);
          this.rawBuffer.splice(0, frameSize);
      }
  }

  private parseADC(payload: number[]) {
      let offset = 1;
      let channel = 0;
      while (offset + 3 <= payload.length) {
          const val = (payload[offset+2] << 16) | (payload[offset+1] << 8) | payload[offset];
          let signed = val & 0x800000 ? val | 0xFF000000 : val;
          if (channel === 0) this.processSignal(signed * SCALE_FACTOR);
          offset += 3;
          channel = (channel + 1) % 2;
      }
  }

  private processSignal(uv: number) {
      const { filtered, quality } = this.dsp.process(uv);
      this.sampleCounter++;
      this.latestData.raw = { timestamp: Date.now(), value: filtered };
      
      if (this.sampleCounter % FFT_UPDATE_INTERVAL === 0) {
          const bands = this.dsp.getSmoothedBands();
          if (bands) {
              // 算法改进：Alpha / (Alpha + Beta) 比率
              // 这是判定冥想深度的核心指标，Alpha 增大且 Beta 减小时，该值会显著上升
              const ratio = bands.alpha / (bands.alpha + bands.beta + 0.1);
              const relaxScore = Math.min(1, ratio * 1.8); // 映射到 0-1 范围
              
              this.latestData.bands = bands;
              this.latestData.metrics = {
                  relaxation: relaxScore,
                  attention: 1 - relaxScore,
                  isMeditating: relaxScore > MEDITATION_THRESHOLD,
                  signalQuality: quality
              };
          }
      }
  }

  public startSimulation() {
    this.isSimulating = true;
    this.simulationInterval = setInterval(() => {
        const bands = { delta: 10, theta: 20, alpha: 45, beta: 15, gamma: 10 };
        this.latestData = {
            raw: { timestamp: Date.now(), value: Math.sin(Date.now()/50)*20 },
            bands,
            metrics: { relaxation: 0.75, attention: 0.25, isMeditating: true, signalQuality: 1.0 }
        };
    }, 100);
  }
}

export const signalProcessor = new DeviceService();
