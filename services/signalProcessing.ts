import { FrequencyBands, AnalysisMetrics, EEGDataPoint } from '../types';
import { MEDITATION_THRESHOLD } from '../constants';

// --------------------------------------------------------------------------
// Web Bluetooth 接口定义
// --------------------------------------------------------------------------

interface BluetoothDevice extends EventTarget {
  id: string;
  name?: string;
  gatt?: BluetoothRemoteGATTServer;
}

interface BluetoothRemoteGATTServer {
  device: BluetoothDevice;
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(service: string | number): Promise<BluetoothRemoteGATTService>;
}

interface BluetoothRemoteGATTService {
  uuid: string;
  device: BluetoothDevice;
  getCharacteristic(characteristic: string | number): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  uuid: string;
  service: BluetoothRemoteGATTService;
  value?: DataView;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  writeValue(value: BufferSource): Promise<void>;
}

// --------------------------------------------------------------------------
// 配置与常量
// --------------------------------------------------------------------------

const VERSION = "v3.5 (Filter Init & Slew Limit)";
const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; 
const UART_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; 

const SCALE_FACTOR = 0.01192; // 转换系数
const SAMPLE_RATE = 250; 
const FFT_SIZE = 256; 

const PROTOCOL_START = 0xAA;
const PROTOCOL_END = 0xBB;

// --------------------------------------------------------------------------
// 辅助函数
// --------------------------------------------------------------------------

export type LogCallback = (msg: string) => void;

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
    private prevInput: number | null = null; // Changed to null for initialization check
    private prevOutput: number = 0;
    
    // 中值滤波缓存 (去除脉冲噪声)
    private medianBuffer: number[] = [];
    
    // Slew Rate Limiter (防止突变)
    private lastValidRaw: number | null = null;

    reset() {
        this.buffer = [];
        this.prevInput = null;
        this.prevOutput = 0;
        this.medianBuffer = [];
        this.lastValidRaw = null;
    }

    process(sample: number): number {
        // 0. Slew Rate Limiter (跳变抑制)
        // EEG 信号在 4ms (250Hz) 内不可能跳变超过 5000uV (5mV)。
        // 如果跳变过大，很可能是解析错误或伪迹，保持上一个值。
        let cleanSample = sample;
        if (this.lastValidRaw !== null) {
            const diff = Math.abs(sample - this.lastValidRaw);
            if (diff > 5000) { 
                // 忽略这个突变点，使用上一个有效值
                cleanSample = this.lastValidRaw;
            } else {
                this.lastValidRaw = sample;
            }
        } else {
            this.lastValidRaw = sample;
        }

        // 1. 中值滤波 (Median Filter) 
        this.medianBuffer.push(cleanSample);
        if (this.medianBuffer.length > 5) {
            this.medianBuffer.shift();
        }
        
        let filteredSample = cleanSample;
        if (this.medianBuffer.length >= 3) {
            const sorted = [...this.medianBuffer].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            filteredSample = sorted[mid];
        }

        // 2. 去直流漂移 (High-pass Filter)
        // 初始化逻辑：如果这是第一个点，初始化 prevInput 为当前值，这样 output 为 0
        if (this.prevInput === null) {
            this.prevInput = filteredSample;
            this.prevOutput = 0;
            return 0;
        }

        const output = filteredSample - this.prevInput + 0.995 * this.prevOutput;
        this.prevInput = filteredSample;
        this.prevOutput = output;
        
        this.buffer.push(output);
        if (this.buffer.length > FFT_SIZE) {
            this.buffer.shift();
        }
        return output;
    }

    getFFT(): FrequencyBands {
        if (this.buffer.length < FFT_SIZE) return { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
        
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
            let count = 0;
            for(let i=minBin; i<=maxBin && i < mags.length; i++) {
                sum += mags[i];
                count++;
            }
            return count > 0 ? sum / count : 0;
        };

        return {
            delta: getPower(0.5, 4),
            theta: getPower(4, 8),
            alpha: getPower(8, 14),
            beta: getPower(14, 28),
            gamma: getPower(28, 40)
        };
    }
}

// --------------------------------------------------------------------------
// 蓝牙设备服务类
// --------------------------------------------------------------------------

export class DeviceService {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private rxChar: BluetoothRemoteGATTCharacteristic | null = null; 
  
  private isConnected: boolean = false;
  private logCallback: LogCallback | null = null;
  
  private rawBuffer: number[] = [];
  private dsp: SignalProcessor = new SignalProcessor();

  private debugRawEnabled: boolean = false;
  private ignoreCRC: boolean = false;

  private latestData: { 
    raw: EEGDataPoint, 
    bands: FrequencyBands, 
    metrics: AnalysisMetrics 
  } = {
    raw: { timestamp: 0, value: 0 },
    bands: { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 },
    metrics: { attention: 0, relaxation: 0, isMeditating: false }
  };

  private isSimulating: boolean = false;
  private agitationLevel: number = 0;
  private lastAcceleration: { x: number, y: number, z: number } | null = null;
  private simulationInterval: number | null = null;
  
  private isRecording: boolean = false;
  private recordedData: number[] = [];

  public setLogger(cb: LogCallback) {
    this.logCallback = cb;
  }

  private log(msg: string) {
    console.log(msg);
    if (this.logCallback) this.logCallback(msg);
  }

  public getIsConnected() { return this.isConnected || this.isSimulating; }
  public isSimulationMode() { return this.isSimulating; }
  public getDataSnapshot() { return this.latestData; }

  public setDebugRaw(enabled: boolean) {
      this.debugRawEnabled = enabled;
      this.log(`>>> 嗅探模式: ${enabled ? '开启' : '关闭'}`);
  }

  public setIgnoreCRC(enabled: boolean) {
      this.ignoreCRC = enabled;
      this.log(`>>> 强制解析(忽略CRC): ${enabled ? '开启' : '关闭'}`);
  }

  public startRecording() {
      this.isRecording = true;
      this.recordedData = [];
      this.log(">>> 开始录制...");
  }

  public stopRecording(): string {
      this.isRecording = false;
      this.log(`>>> 录制结束。共 ${this.recordedData.length} 点。`);
      const json = JSON.stringify(this.recordedData);
      console.log("Recorded Data:", json);
      return json;
  }

  public getIsRecording() { return this.isRecording; }

  public async connect(): Promise<boolean> {
    if (this.isSimulating) this.stopSimulation();
    if (!(navigator as any).bluetooth) {
      alert("请使用 Bluefy (iOS) 或 Chrome (Android)。");
      return false;
    }

    try {
      this.log(`正在初始化 ${VERSION}...`);
      this.dsp.reset(); // 重置滤波器状态
      
      this.device = await (navigator as any).bluetooth.requestDevice({
        filters: [{ namePrefix: 'SILI' }], 
        optionalServices: [UART_SERVICE_UUID] 
      });

      if (!this.device || !this.device.gatt) return false;

      this.device.addEventListener('gattserverdisconnected', this.onDisconnected.bind(this));
      this.log(`设备: ${this.device.name}`);

      this.server = await this.device.gatt.connect();
      this.isConnected = true;
      this.log("GATT 连接成功");

      const service = await this.server.getPrimaryService(UART_SERVICE_UUID);
      this.rxChar = await service.getCharacteristic(UART_RX_CHAR_UUID); 
      const txChar = await service.getCharacteristic(UART_TX_CHAR_UUID); 

      this.log("开启通知...");
      await txChar.startNotifications();
      txChar.addEventListener('characteristicvaluechanged', this.handleBluetoothData.bind(this));

      // 自动配置重试逻辑
      this.log("正在尝试自动配置...");
      // 延迟 500ms 发送第一次
      await new Promise(r => setTimeout(r, 500));
      await this.performAutoConfig();
      
      // 再延迟 1000ms 发送第二次 (确保设备已就绪)
      await new Promise(r => setTimeout(r, 1000));
      await this.performAutoConfig();

      return true;

    } catch (e: any) {
      this.log(`连接错误: ${e.message}`);
      this.disconnect();
      throw e;
    }
  }

  public async sendFrame(func: number, addr: number, data: number[] = []) {
      if (!this.rxChar) return;
      const len = data.length;
      const payloadForCrc = [func, addr, len, ...data];
      const crc = calculateCRC8(new Uint8Array(payloadForCrc));
      const packet = new Uint8Array([PROTOCOL_START, ...payloadForCrc, crc, PROTOCOL_END]);
      
      const hexStr = Array.from(packet).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
      this.log(`TX >>> ${hexStr}`);
      
      try { await this.rxChar.writeValue(packet); } catch(e) { this.log(`发送失败: ${e}`); }
  }

  public async performAutoConfig() {
      this.log(">>> 执行自动配置 (0x60)...");
      await this.sendFrame(0x60, 0x00, []);
  }

  public async sendStop() {
      this.log(">>> 发送停止指令...");
      await this.sendFrame(0x11, 0x00, []);
      await new Promise(r => setTimeout(r, 50));
      await this.sendFrame(0x0A, 0x00, []);
  }
  
  public async sendHexCommand(hex: string) {
      if (!this.rxChar) return;
      const cleanHex = hex.replace(/[^0-9A-Fa-f]/g, '');
      const bytes = new Uint8Array(cleanHex.length / 2);
      for (let i = 0; i < cleanHex.length; i += 2) {
          bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
      }
      this.log(`TX [RAW] >>> ${Array.from(bytes).map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join(' ')}`);
      try { await this.rxChar.writeValue(bytes); } catch(e) { this.log(`Err: ${e}`); }
  }

  public disconnect() {
    if (this.isSimulating) {
        this.stopSimulation();
        return;
    }
    if (this.server && this.server.connected) {
      this.server.disconnect();
    }
    this.device = null;
    this.server = null;
    this.isConnected = false;
    this.rawBuffer = [];
    this.dsp.reset();
    this.log("蓝牙已断开");
  }

  private onDisconnected() {
    this.log("蓝牙连接丢失");
    this.isConnected = false;
  }

  private handleBluetoothData(event: any) {
      const value = event.target.value as DataView;
      const newBytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      
      if (this.debugRawEnabled) {
          const hex = Array.from(newBytes).map(b => b.toString(16).padStart(2,'0')).join(' ');
          this.log(`RX RAW: ${hex}`);
      }

      for (let i = 0; i < value.byteLength; i++) {
          this.rawBuffer.push(value.getUint8(i));
      }
      this.processRawBuffer();
  }

  private processRawBuffer() {
      if (this.rawBuffer.length > 4096) {
          this.log("Buffer overflow, reset");
          this.rawBuffer = [];
      }

      while (this.rawBuffer.length >= 7) {
          if (this.rawBuffer[0] !== PROTOCOL_START) {
              this.rawBuffer.shift();
              continue;
          }

          const payloadLen = this.rawBuffer[3];
          const frameSize = 6 + payloadLen; 

          if (this.rawBuffer.length < frameSize) {
              return; 
          }

          if (this.rawBuffer[frameSize - 1] !== PROTOCOL_END) {
              this.rawBuffer.shift(); 
              continue;
          }

          const calcData = this.rawBuffer.slice(1, frameSize - 2);
          const calculatedCrc = calculateCRC8(calcData);
          const receivedCrc = this.rawBuffer[frameSize - 2];

          if (receivedCrc !== calculatedCrc && !this.ignoreCRC) {
              this.log(`CRC 失败: Rx ${receivedCrc.toString(16)} != Calc ${calculatedCrc.toString(16)}`);
              this.rawBuffer.shift();
              continue;
          }

          const funcCode = this.rawBuffer[1];
          const payload = this.rawBuffer.slice(4, 4 + payloadLen);
          
          this.parsePacket(funcCode, payload);

          this.rawBuffer.splice(0, frameSize);
      }
  }

  private parsePacket(func: number, payload: number[]) {
      switch (func) {
          case 0xF0: // ADC 数据帧
              this.parseADCData(payload);
              break;
          case 0xF1: // 状态帧
              this.parseStatusFrame(payload);
              break;
          case 0xEE: // 错误帧
              this.log(`RX 错误帧: Code ${payload[0].toString(16)}`);
              break;
          case 0x20: // ID 回显
              this.log(`RX 设备ID: ${payload[0].toString(16)}`);
              break;
      }
  }

  private parseADCData(payload: number[]) {
      let offset = 0;
      
      while (offset < payload.length) {
          let val = 0;
          
          if (offset === 0) {
              // --- 第一个样本 (6字节) ---
              // 格式: [S0, S1, S2, D0, D1, D2]
              if (offset + 6 > payload.length) break;
              
              // Little Endian: D0=p[3], D1=p[4], D2=p[5]
              val = (payload[offset+5] << 16) | (payload[offset+4] << 8) | payload[offset+3];
              
              offset += 6;
          } else {
              // --- 后续样本 (4字节) ---
              // 格式: [S0, D0, D1, D2]
              if (offset + 4 > payload.length) break;
              
              val = (payload[offset+3] << 16) | (payload[offset+2] << 8) | payload[offset+1];
              
              offset += 4;
          }

          // 24-bit 补码符号扩展
          if (val & 0x800000) {
              val = val | 0xFF000000;
          }

          const uv = val * SCALE_FACTOR;
          this.processSignal(uv);
      }
  }
  
  private parseStatusFrame(payload: number[]) {
      if (payload.length >= 3) {
          const batt = payload[2];
          const lead = payload[1];
          if (Math.random() < 0.05) this.log(`电池: ${batt}%, 导联: ${lead.toString(2)}`);
      }
  }

  private processSignal(uv: number) {
      if (this.isRecording) {
          this.recordedData.push(uv);
      }

      const filtered = this.dsp.process(uv);
      
      // 只有在滤波器初始化完成后(不是0)才开始更新UI数据，避免初始的0直线
      if (filtered !== 0) {
          this.latestData.raw = { timestamp: Date.now(), value: filtered };
          
          const bands = this.dsp.getFFT();
          
          const eps = 0.1;
          const totalPower = bands.delta + bands.theta + bands.alpha + bands.beta + bands.gamma + eps;
          
          const relMetric = (bands.alpha * 1.5 + bands.theta) / (totalPower + bands.beta * 0.5); 
          const attMetric = (bands.beta + bands.gamma) / totalPower;

          // 平滑处理
          const prevRel = this.latestData.metrics.relaxation;
          const smoothRel = prevRel * 0.92 + Math.min(1.0, relMetric) * 0.08;
          
          const smoothAtt = this.latestData.metrics.attention * 0.9 + attMetric * 0.1;

          this.latestData.bands = bands;
          this.latestData.metrics = {
              relaxation: smoothRel,
              attention: smoothAtt,
              isMeditating: smoothRel > MEDITATION_THRESHOLD
          };
      }
  }

  // --------------------------------------------------------------------------
  // 模拟模式
  // --------------------------------------------------------------------------
  public async requestMotionPermission(): Promise<boolean> {
      if (typeof (DeviceMotionEvent as any) !== 'undefined' && typeof (DeviceMotionEvent as any).requestPermission === 'function') {
        try { return await (DeviceMotionEvent as any).requestPermission() === 'granted'; } catch { return false; }
      }
      return true;
  }
  public startSimulation() {
    if (this.isConnected) this.disconnect();
    this.isSimulating = true;
    this.agitationLevel = 0;
    this.dsp.reset();
    window.addEventListener('devicemotion', this.handleMotion);
    if (this.simulationInterval) clearInterval(this.simulationInterval);
    this.simulationInterval = window.setInterval(() => this.updateSimulation(), 100);
    this.log("模拟模式已启动");
  }
  public stopSimulation() {
    this.isSimulating = false;
    window.removeEventListener('devicemotion', this.handleMotion);
    if (this.simulationInterval) clearInterval(this.simulationInterval);
    this.simulationInterval = null;
    this.log("模拟模式已停止");
  }
  private handleMotion = (event: DeviceMotionEvent) => {
    const acc = event.accelerationIncludingGravity;
    if (!acc || !this.lastAcceleration) {
        this.lastAcceleration = { x: acc?.x||0, y: acc?.y||0, z: acc?.z||0 };
        return;
    }
    const delta = Math.abs((acc.x||0) - this.lastAcceleration.x) + Math.abs((acc.y||0) - this.lastAcceleration.y) + Math.abs((acc.z||0) - this.lastAcceleration.z);
    if (delta > 0.5) this.agitationLevel += delta * 5;
    this.lastAcceleration = { x: acc.x||0, y: acc.y||0, z: acc.z||0 };
  }
  private updateSimulation() {
    this.agitationLevel = Math.max(0, this.agitationLevel * 0.9);
    const rel = Math.max(0, 1 - (this.agitationLevel / 50));
    this.latestData = {
        raw: { timestamp: Date.now(), value: Math.sin(Date.now()/50)*10 + (Math.random()-0.5)*5 },
        bands: { delta: 5, theta: 5, alpha: rel*40, beta: (1-rel)*20, gamma: 5 },
        metrics: { relaxation: rel, attention: 1-rel, isMeditating: rel > 0.8 }
    };
  }
}

export const signalProcessor = new DeviceService();
