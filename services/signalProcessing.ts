
import { FrequencyBands, AnalysisMetrics, EEGDataPoint } from '../types';

// --------------------------------------------------------------------------
// 配置与常量
// --------------------------------------------------------------------------

const VERSION = "v4.0 (Zen Master)";
const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; 
const UART_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; 

const SCALE_FACTOR = 0.01192; 
const SAMPLE_RATE = 250; 
const FFT_SIZE = 256; 
const FFT_UPDATE_INTERVAL = 25; 

const PROTOCOL_START = 0xAA;
const PROTOCOL_END = 0xBB;

/**
 * Log callback type for device status reporting
 */
type LogCallback = (message: string) => void;

class SignalProcessor {
    private buffer: number[] = [];
    
    // 滤波器状态：针对 35000uV 的直流偏置，使用更强的二阶高通滤波
    private hp_v1: number = 0;
    private hp_v2: number = 0;
    private lpfPrev: number = 0; 
    
    private medianBuffer: number[] = [];
    private lastValidRaw: number | null = null;

    // 伪迹防护：适当放宽以适应用户深呼吸时的电压起伏
    private artifactLockout: number = 0;
    private readonly ARTIFACT_DURATION = 125; 
    private readonly NOISE_THRESHOLD_UV = 1200; 

    // 历史平滑
    private bandHistory: FrequencyBands[] = [];
    private readonly HISTORY_SIZE = 15; 

    reset() {
        this.buffer = [];
        this.hp_v1 = 0;
        this.hp_v2 = 0;
        this.lpfPrev = 0;
        this.medianBuffer = [];
        this.lastValidRaw = null;
        this.bandHistory = [];
        this.artifactLockout = 0;
    }

    /**
     * 核心处理逻辑：去直流 -> 中值滤波 -> 高通滤波 -> 低通滤波
     */
    process(sample: number): { filtered: number, quality: number } {
        // 1. 异常跳变剔除
        let cleanSample = sample;
        if (this.lastValidRaw !== null) {
            if (Math.abs(sample - this.lastValidRaw) > 8000) {
                cleanSample = this.lastValidRaw;
            } else {
                this.lastValidRaw = sample;
            }
        } else {
            this.lastValidRaw = sample;
        }

        // 2. 中值滤波：去除刺尖噪音
        this.medianBuffer.push(cleanSample);
        if (this.medianBuffer.length > 5) this.medianBuffer.shift();
        let medSample = cleanSample;
        if (this.medianBuffer.length >= 3) {
            const sorted = [...this.medianBuffer].sort((a, b) => a - b);
            medSample = sorted[Math.floor(sorted.length / 2)];
        }

        // 3. 二阶高通滤波器 (约 1Hz 切断)：专门针对 35000uV 的偏移
        // 使用 Direct Form II 实现，系数针对 250Hz 采样率优化
        const x = medSample;
        const out = x - 2.0 * this.hp_v1 + this.hp_v2 + (1.9822 * this.hp_v1 - 0.9824 * this.hp_v2);
        this.hp_v2 = this.hp_v1;
        this.hp_v1 = out;

        // 4. 低通滤波 (约 35Hz)：滤除工频和肌肉电
        const finalOutput = this.lpfPrev + 0.25 * (out - this.lpfPrev);
        this.lpfPrev = finalOutput;
        
        // 5. FFT 缓存
        this.buffer.push(finalOutput);
        if (this.buffer.length > FFT_SIZE) this.buffer.shift();

        // 6. 质量评估
        if (Math.abs(finalOutput) > this.NOISE_THRESHOLD_UV) {
            this.artifactLockout = this.ARTIFACT_DURATION;
        }
        if (this.artifactLockout > 0) this.artifactLockout--;
        const quality = this.artifactLockout > 0 ? 0.2 : 1.0;

        return { filtered: finalOutput, quality };
    }

    /**
     * 计算相对功率谱密度
     */
    getSmoothedBands(): FrequencyBands | null {
        if (this.buffer.length < FFT_SIZE) return null;

        // 汉宁窗加窗以减少频谱泄露
        const windowed = this.buffer.map((v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))));
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

        const absoluteBands = {
            delta: getPower(0.5, 4),
            theta: getPower(4, 8),
            alpha: getPower(8, 13),
            beta: getPower(13, 30),
            gamma: getPower(30, 45)
        };

        const totalPower = Object.values(absoluteBands).reduce((a, b) => a + b, 0) + 0.0001;
        
        const relativeBands: FrequencyBands = {
            delta: (absoluteBands.delta / totalPower) * 100,
            theta: (absoluteBands.theta / totalPower) * 100,
            alpha: (absoluteBands.alpha / totalPower) * 100,
            beta:  (absoluteBands.beta  / totalPower) * 100,
            gamma: (absoluteBands.gamma / totalPower) * 100
        };

        this.bandHistory.push(relativeBands);
        if (this.bandHistory.length > this.HISTORY_SIZE) this.bandHistory.shift();

        return this.averageBands(this.bandHistory);
    }

    private averageBands(history: FrequencyBands[]): FrequencyBands {
        const sum = history.reduce((acc, curr) => ({
            delta: acc.delta + curr.delta,
            theta: acc.theta + curr.theta,
            alpha: acc.alpha + curr.alpha,
            beta:  acc.beta + curr.beta,
            gamma: acc.gamma + curr.gamma,
        }), { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 });
        const len = history.length;
        return {
            delta: sum.delta / len, theta: sum.theta / len,
            alpha: sum.alpha / len, beta: sum.beta / len, gamma: sum.gamma / len,
        };
    }
}

// --------------------------------------------------------------------------
// 设备服务类
// --------------------------------------------------------------------------

export class DeviceService {
  private device: any = null;
  private server: any = null;
  private rxChar: any = null; 
  private isConnected: boolean = false;
  private logCallback: LogCallback | null = null;
  private rawBuffer: number[] = [];
  private dsp: SignalProcessor = new SignalProcessor();
  private sampleCounter: number = 0;
  private isSimulating: boolean = false;
  private isRecording: boolean = false;
  private recordedData: number[] = [];

  private latestData = {
    raw: { timestamp: 0, value: 0 },
    bands: { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 },
    metrics: { attention: 0, relaxation: 0, isMeditating: false, signalQuality: 1.0 }
  };

  public setLogger(cb: LogCallback) { this.logCallback = cb; }
  private log(msg: string) { if (this.logCallback) this.logCallback(msg); }

  public getIsConnected() { return this.isConnected || this.isSimulating; }
  public isSimulationMode() { return this.isSimulating; }
  public getDataSnapshot() { return this.latestData; }
  public getIsRecording() { return this.isRecording; }

  public async connect(): Promise<boolean> {
    if (!(navigator as any).bluetooth) return false;
    try {
      this.log(`>>> 初始化 ZenMaster 4.0 算法...`);
      this.dsp.reset(); 
      this.device = await (navigator as any).bluetooth.requestDevice({
        filters: [{ namePrefix: 'SILI' }], 
        optionalServices: [UART_SERVICE_UUID] 
      });
      this.server = await this.device.gatt.connect();
      this.isConnected = true;
      const service = await this.server.getPrimaryService(UART_SERVICE_UUID);
      this.rxChar = await service.getCharacteristic(UART_RX_CHAR_UUID); 
      const txChar = await service.getCharacteristic(UART_TX_CHAR_UUID); 
      await txChar.startNotifications();
      txChar.addEventListener('characteristicvaluechanged', (e: any) => {
          const val = e.target.value;
          for (let i = 0; i < val.byteLength; i++) this.rawBuffer.push(val.getUint8(i));
          this.processRawBuffer();
      });
      await this.sendFrame(0x60, 0x00, []); // 自动配置
      return true;
    } catch (e: any) {
      this.log(`连接失败: ${e.message}`);
      return false;
    }
  }

  private processRawBuffer() {
      while (this.rawBuffer.length >= 7) {
          if (this.rawBuffer[0] !== PROTOCOL_START) { this.rawBuffer.shift(); continue; }
          const payloadLen = this.rawBuffer[3];
          const frameSize = 6 + payloadLen; 
          if (this.rawBuffer.length < frameSize) return; 
          if (this.rawBuffer[frameSize - 1] !== PROTOCOL_END) { this.rawBuffer.shift(); continue; }
          const funcCode = this.rawBuffer[1];
          const payload = this.rawBuffer.slice(4, 4 + payloadLen);
          if (funcCode === 0xF0) this.parseADCData(payload);
          this.rawBuffer.splice(0, frameSize);
      }
  }

  private parseADCData(payload: number[]) {
      let offset = 1;
      let channelIndex = 0;
      while (offset + 3 <= payload.length) {
          const val = (payload[offset+2] << 16) | (payload[offset+1] << 8) | payload[offset];
          let signedVal = val & 0x800000 ? val | 0xFF000000 : val;
          if (channelIndex === 0) this.processSignal(signedVal * SCALE_FACTOR);
          offset += 3;
          channelIndex = (channelIndex + 1) % 2;
      }
  }

  private processSignal(uv: number) {
      if (this.isRecording) this.recordedData.push(uv);
      const { filtered, quality } = this.dsp.process(uv);
      this.sampleCounter++;
      this.latestData.raw = { timestamp: Date.now(), value: filtered };
      this.latestData.metrics.signalQuality = quality;

      if (this.sampleCounter % FFT_UPDATE_INTERVAL === 0) {
          const bands = this.dsp.getSmoothedBands();
          if (bands) {
              this.latestData.bands = bands;
              // 算法改进：使用 Alpha/Beta 比率作为主要放松指标
              const alphaBetaRatio = bands.alpha / (bands.beta + 0.1);
              const relScore = Math.min(1.0, alphaBetaRatio / 2.5); // 映射到 0-1
              const attnScore = Math.min(1.0, bands.beta / 40);

              this.latestData.metrics = {
                  relaxation: relScore,
                  attention: attnScore,
                  isMeditating: relScore > 0.6,
                  signalQuality: quality
              };
          }
      }
  }

  public disconnect() {
    if (this.server) this.server.disconnect();
    this.isConnected = false;
    this.dsp.reset();
  }

  public async sendFrame(func: number, addr: number, data: number[] = []) {
      if (!this.rxChar) return;
      const packet = new Uint8Array([PROTOCOL_START, func, addr, data.length, ...data, 0x00, PROTOCOL_END]);
      await this.rxChar.writeValue(packet);
  }

  public startRecording() { this.isRecording = true; this.recordedData = []; }
  public stopRecording() { this.isRecording = false; return JSON.stringify(this.recordedData); }
  
  // 模拟逻辑保持不变...
  public startSimulation() { this.isSimulating = true; }
  public stopSimulation() { this.isSimulating = false; }
}

export const signalProcessor = new DeviceService();
