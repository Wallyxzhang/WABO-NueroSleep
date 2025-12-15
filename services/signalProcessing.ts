import { FrequencyBands, AnalysisMetrics, EEGDataPoint } from '../types';
import { MEDITATION_THRESHOLD } from '../constants';

// --------------------------------------------------------------------------
// Web Bluetooth Interfaces
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
// Configuration
// --------------------------------------------------------------------------

const VERSION = "v2.5 (Data Recorder)";
const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Write
const UART_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Notify

const SCALE_FACTOR = (2.454 / (12 * 8388608)) * 1000000;
const SAMPLE_RATE = 250; 
const FFT_SIZE = 256; 

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

export type LogCallback = (msg: string) => void;

function calculateCRC8(data: Uint8Array | number[]): number {
  let crc = 0x00;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x01) {
        crc = (crc >> 1) ^ 0x8C; 
      } else {
        crc >>= 1;
      }
    }
  }
  return crc;
}

class SignalProcessor {
    private buffer: number[] = [];
    private prevInput: number = 0;
    private prevOutput: number = 0;

    process(sample: number): number {
        // DC Blocker (High-pass filter at ~0.5Hz)
        const output = sample - this.prevInput + 0.995 * this.prevOutput;
        this.prevInput = sample;
        this.prevOutput = output;
        
        this.buffer.push(output);
        if (this.buffer.length > FFT_SIZE) {
            this.buffer.shift();
        }
        return output;
    }

    getFFT(): FrequencyBands {
        if (this.buffer.length < FFT_SIZE) return { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
        
        // Hanning Window
        const windowed = this.buffer.map((v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))));
        const mags = new Float32Array(FFT_SIZE / 2);
        
        // DFT Calculation
        for (let k = 0; k < FFT_SIZE / 2; k++) {
             let real = 0; let imag = 0;
             for (let n = 0; n < FFT_SIZE; n++) {
                 const theta = -2 * Math.PI * k * n / FFT_SIZE;
                 real += windowed[n] * Math.cos(theta);
                 imag += windowed[n] * Math.sin(theta);
             }
             // FIXED: Normalize FFT magnitude by dividing by (N/2)
             // Before: Values proportional to N (~128x too large). Now: True amplitude in uV.
             mags[k] = (2 * Math.sqrt(real * real + imag * imag)) / FFT_SIZE;
        }
        
        const res = SAMPLE_RATE / FFT_SIZE; // ~0.97 Hz per bin
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
// Device Service
// --------------------------------------------------------------------------

export class DeviceService {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private rxChar: BluetoothRemoteGATTCharacteristic | null = null; 
  
  private isConnected: boolean = false;
  private logCallback: LogCallback | null = null;
  
  private rawBuffer: number[] = [];
  private dsp: SignalProcessor = new SignalProcessor();

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
  
  private retryMode: number = 1; 

  // Data Recording for Analysis
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

  // --------------------------------------------------------------------------
  // Recording API
  // --------------------------------------------------------------------------
  public startRecording() {
      this.isRecording = true;
      this.recordedData = [];
      this.log(">>> 开始录制原始数据...");
  }

  public stopRecording(): string {
      this.isRecording = false;
      this.log(`>>> 录制结束。共采集 ${this.recordedData.length} 个点。`);
      return JSON.stringify(this.recordedData);
  }

  public getIsRecording() { return this.isRecording; }

  // --------------------------------------------------------------------------
  // Connect Logic
  // --------------------------------------------------------------------------

  public async connect(): Promise<boolean> {
    if (this.isSimulating) this.stopSimulation();
    if (!(navigator as any).bluetooth) {
      alert("请使用 Bluefy (iOS) 或 Chrome (Android)。");
      return false;
    }

    try {
      this.log(`正在初始化 ${VERSION}...`);
      
      this.device = await (navigator as any).bluetooth.requestDevice({
        filters: [{ namePrefix: 'SILI' }], 
        optionalServices: [UART_SERVICE_UUID] 
      });

      if (!this.device || !this.device.gatt) return false;

      this.device.addEventListener('gattserverdisconnected', this.onDisconnected.bind(this));
      this.log(`设备已选择: ${this.device.name}`);

      this.server = await this.device.gatt.connect();
      this.isConnected = true;
      this.log("GATT 连接成功");

      const service = await this.server.getPrimaryService(UART_SERVICE_UUID);
      this.log(`服务就绪: ${service.uuid.substring(0,8)}...`);

      this.rxChar = await service.getCharacteristic(UART_RX_CHAR_UUID); 
      const txChar = await service.getCharacteristic(UART_TX_CHAR_UUID); 

      this.log("开启数据监听...");
      await txChar.startNotifications();
      txChar.addEventListener('characteristicvaluechanged', this.handleBluetoothData.bind(this));

      this.log("等待通道稳定 (1秒)...");
      await new Promise(resolve => setTimeout(resolve, 1000));

      await this.performHandshake();
      
      return true;

    } catch (e: any) {
      this.log(`错误: ${e.message}`);
      this.disconnect();
      throw e;
    }
  }

  public async performHandshake() {
      if (!this.device || !this.rxChar) {
          this.log("无法握手: 未连接");
          return;
      }

      const name = this.device.name || "SILI_000000";
      let idBytes = [0x00, 0x00, 0x00];
      let methodStr = "Default";

      if (this.retryMode === 0) {
          const match = name.match(/([0-9A-F]{6})$/i);
          if (match) {
              const hex = match[1];
              idBytes[0] = parseInt(hex.substring(0, 2), 16);
              idBytes[1] = parseInt(hex.substring(2, 4), 16);
              idBytes[2] = parseInt(hex.substring(4, 6), 16);
              methodStr = `NameID (${hex})`;
          }
      } 
      else if (this.retryMode === 1) {
          idBytes = [0x00, 0x00, 0x00];
          methodStr = "ZeroID (000000)";
      }
      else if (this.retryMode === 2) {
          const match = name.match(/([0-9A-F]{6})$/i);
          if (match) {
              const hex = match[1];
              idBytes[2] = parseInt(hex.substring(0, 2), 16);
              idBytes[1] = parseInt(hex.substring(2, 4), 16);
              idBytes[0] = parseInt(hex.substring(4, 6), 16);
              methodStr = `RevID`;
          }
      }

      const payloadForCrc = [0xB0, 0xB0, 0x03, ...idBytes];
      const crc = calculateCRC8(new Uint8Array(payloadForCrc));
      const packet = new Uint8Array([0xAA, ...payloadForCrc, crc, 0xBB]);

      const hexStr = Array.from(packet).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
      this.log(`TX [${methodStr}] >>> ${hexStr}`);
      
      try {
          await this.rxChar.writeValue(packet);
      } catch (e) {
          this.log(`写入失败: ${e}`);
      }
  }

  public async retryHandshake() {
      this.retryMode = (this.retryMode + 1) % 3;
      this.log(`>>> 尝试握手策略 #${this.retryMode}`);
      await this.performHandshake();
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
    this.log("已断开");
  }

  private onDisconnected() {
    this.log("蓝牙已断开");
    this.isConnected = false;
  }

  // --------------------------------------------------------------------------
  // Data Parsing
  // --------------------------------------------------------------------------

  private handleBluetoothData(event: any) {
      const value = event.target.value as DataView;
      for (let i = 0; i < value.byteLength; i++) {
          this.rawBuffer.push(value.getUint8(i));
      }
      this.processRawBuffer();
  }

  private processRawBuffer() {
      while (this.rawBuffer.length > 0) {
          const startIdx = this.rawBuffer.indexOf(0xAA);
          if (startIdx === -1) {
              this.rawBuffer = []; 
              return;
          }
          if (startIdx > 0) {
              this.rawBuffer.splice(0, startIdx); 
          }

          if (this.rawBuffer.length < 4) return; 

          const len = this.rawBuffer[3];
          const frameSize = 6 + len; 

          if (this.rawBuffer.length < frameSize) return; 

          if (this.rawBuffer[frameSize - 1] !== 0xBB) {
              this.rawBuffer.shift(); 
              continue; 
          }

          const func = this.rawBuffer[1];
          const payload = this.rawBuffer.slice(4, 4 + len);
          
          if (func === 0xF0 || func === 0xF1) {
              this.parseSamples(payload);
          } else if (func === 0xEE) {
               // Heartbeat
          } else {
              this.log(`RX FUNC=${func.toString(16)} LEN=${len}`);
          }

          this.rawBuffer.splice(0, frameSize);
      }
  }

  private parseSamples(payload: number[]) {
      for (let i = 0; i < payload.length; i += 3) {
          if (i + 2 >= payload.length) break;
          
          let val = (payload[i] << 16) | (payload[i+1] << 8) | payload[i+2];
          if (val & 0x800000) val = val - 0x1000000;
          
          const uv = val * SCALE_FACTOR;
          this.processSignal(uv);
      }
  }

  private processSignal(uv: number) {
      // Record raw data before filter (or after? Let's record after DC blocker to be useful)
      // Actually, for analysis, let's record the value coming INTO the DSP loop (the calibrated uV)
      if (this.isRecording) {
          this.recordedData.push(uv);
      }

      const filtered = this.dsp.process(uv);
      
      this.latestData.raw = { timestamp: Date.now(), value: filtered };
      
      const bands = this.dsp.getFFT();
      
      const eps = 0.1;
      const totalPower = bands.delta + bands.theta + bands.alpha + bands.beta + bands.gamma + eps;
      const relMetric = (bands.alpha + bands.theta) / totalPower; 
      const attMetric = (bands.beta + bands.gamma) / totalPower;

      const prevRel = this.latestData.metrics.relaxation;
      const smoothRel = prevRel * 0.9 + relMetric * 0.1;
      const smoothAtt = this.latestData.metrics.attention * 0.9 + attMetric * 0.1;

      this.latestData.bands = bands;
      this.latestData.metrics = {
          relaxation: smoothRel,
          attention: smoothAtt,
          isMeditating: smoothRel > MEDITATION_THRESHOLD
      };
  }

  // --------------------------------------------------------------------------
  // Simulation
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
