import { FrequencyBands, AnalysisMetrics, EEGDataPoint } from '../types';
import { MEDITATION_THRESHOLD } from '../constants';

// --------------------------------------------------------------------------
// Protocol Constants
// --------------------------------------------------------------------------

// Nordic UART Service (Standard for many BLE Serial bridges)
const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Write (App -> Device)
const UART_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Notify (Device -> App)

// Physics Constants from PDF
// Vref = 4.5V? or 2.454V? PDF says: 2.454 / (12 * 2^23) * 10^6
// Let's use the explicit multiplier derived from PDF Eq 2.
// Scale = 2.454 / (12 * 8388608) * 1000000 approx 0.02437
const SCALE_FACTOR = (2.454 / (12 * 8388608)) * 1000000;

const SAMPLE_RATE = 250; 
const FFT_SIZE = 256; // Power of 2 close to 1 second

// --------------------------------------------------------------------------
// Types & Interfaces
// --------------------------------------------------------------------------

export type LogCallback = (msg: string) => void;

declare global {
  interface Navigator {
    bluetooth: Bluetooth;
  }
  interface Bluetooth {
    requestDevice(options?: RequestDeviceOptions): Promise<BluetoothDevice>;
  }
  interface RequestDeviceOptions {
    filters?: BluetoothLEScanFilter[];
    optionalServices?: string[];
    acceptAllDevices?: boolean;
  }
  interface BluetoothLEScanFilter {
    namePrefix?: string;
    services?: string[];
  }
  interface BluetoothDevice {
    id: string;
    name?: string;
    gatt?: BluetoothRemoteGATTServer;
    addEventListener(type: string, listener: EventListener): void;
  }
  interface BluetoothRemoteGATTServer {
    connected: boolean;
    connect(): Promise<BluetoothRemoteGATTServer>;
    disconnect(): void;
    getPrimaryService(service: string): Promise<BluetoothRemoteGATTService>;
  }
  interface BluetoothRemoteGATTService {
    uuid: string;
    getCharacteristic(characteristic: string): Promise<BluetoothRemoteGATTCharacteristic>;
  }
  interface BluetoothRemoteGATTCharacteristic {
    uuid: string;
    properties: { notify: boolean; write: boolean };
    startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
    writeValue(value: BufferSource): Promise<void>;
    addEventListener(type: string, listener: (event: any) => void): void;
    value?: DataView;
  }
}

// --------------------------------------------------------------------------
// Helpers: CRC8 & Math
// --------------------------------------------------------------------------

// Maxim/Dallas CRC-8: x^8 + x^5 + x^4 + 1 (Poly: 0x31)
// Init 0x00, Final XOR 0x00
function calculateCRC8(data: Uint8Array | number[]): number {
  let crc = 0x00;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 0x01) {
        crc = (crc >> 1) ^ 0x8C; // 0x8C is bit-reversed 0x31 (0x18C >> 1? No. Standard implementation)
        // Wait, standard Maxim implementation:
        // Poly 0x31 (0011 0001). Reversed 0x8C (1000 1100).
        // Let's use a lookup table or standard loop for Maxim.
      } else {
        crc >>= 1;
      }
    }
  }
  return crc;
}

// Simple IIR Filter Class (Highpass, Lowpass, Notch)
class IIRFilter {
  private xv: number[] = [0, 0, 0];
  private yv: number[] = [0, 0, 0];
  private gain: number;
  
  // Coefficients
  private a0: number; private a1: number; private a2: number;
  private b1: number; private b2: number;

  constructor(gain: number, a0: number, a1: number, a2: number, b1: number, b2: number) {
    this.gain = gain;
    this.a0 = a0; this.a1 = a1; this.a2 = a2;
    this.b1 = b1; this.b2 = b2;
  }

  process(input: number): number {
    this.xv[0] = this.xv[1]; this.xv[1] = this.xv[2]; 
    this.xv[2] = input / this.gain;
    this.yv[0] = this.yv[1]; this.yv[1] = this.yv[2]; 
    this.yv[2] = (this.a0 * this.xv[2]) + (this.a1 * this.xv[1]) + (this.a2 * this.xv[0])
                 + (this.b1 * this.yv[1]) + (this.b2 * this.yv[0]);
    return this.yv[2];
  }
}

// Pre-calculated coefficients for 250Hz sampling (Approximations)
// Highpass 0.5Hz, Lowpass 40Hz, Notch 50Hz would be ideal.
// For simplicity in this demo, we use a simple DC blocker (Highpass).
class SignalProcessor {
    private buffer: number[] = [];
    private prevSample: number = 0;
    
    // Simple DC Blocker: y[n] = x[n] - x[n-1] + 0.995 * y[n-1]
    private prevInput: number = 0;
    private prevOutput: number = 0;

    process(sample: number): number {
        const output = sample - this.prevInput + 0.995 * this.prevOutput;
        this.prevInput = sample;
        this.prevOutput = output;
        
        // Push to buffer for FFT
        this.buffer.push(output);
        if (this.buffer.length > FFT_SIZE) {
            this.buffer.shift();
        }
        return output;
    }

    getFFT(): FrequencyBands {
        if (this.buffer.length < FFT_SIZE) {
            return { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
        }
        
        // Windowing (Hanning)
        const windowed = this.buffer.map((v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))));
        
        // Real FFT (simplified for magnitude)
        const mags = new Float32Array(FFT_SIZE / 2);
        for (let k = 0; k < FFT_SIZE / 2; k++) {
             let real = 0;
             let imag = 0;
             for (let n = 0; n < FFT_SIZE; n++) {
                 const theta = -2 * Math.PI * k * n / FFT_SIZE;
                 real += windowed[n] * Math.cos(theta);
                 imag += windowed[n] * Math.sin(theta);
             }
             mags[k] = Math.sqrt(real * real + imag * imag);
        }
        
        // Bin resolution = 250 / 256 ≈ 0.97 Hz per bin
        const res = SAMPLE_RATE / FFT_SIZE;
        
        const getPower = (minHz: number, maxHz: number) => {
            const minBin = Math.floor(minHz / res);
            const maxBin = Math.ceil(maxHz / res);
            let sum = 0;
            for(let i=minBin; i<=maxBin && i < mags.length; i++) sum += mags[i];
            return sum / (maxBin - minBin + 1);
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
// Main Service Class
// --------------------------------------------------------------------------

export class DeviceService {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private rxChar: BluetoothRemoteGATTCharacteristic | null = null; // Write
  
  private isConnected: boolean = false;
  private logCallback: LogCallback | null = null;
  
  // Data Parsing
  private rawBuffer: number[] = []; // Incoming bytes
  private dsp: SignalProcessor = new SignalProcessor();

  // State
  private latestData: { 
    raw: EEGDataPoint, 
    bands: FrequencyBands, 
    metrics: AnalysisMetrics 
  } = {
    raw: { timestamp: 0, value: 0 },
    bands: { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 },
    metrics: { attention: 0, relaxation: 0, isMeditating: false }
  };

  // Simulation
  private isSimulating: boolean = false;
  private agitationLevel: number = 0;
  private lastAcceleration: { x: number, y: number, z: number } | null = null;
  private simulationInterval: number | null = null;

  constructor() {}

  public setLogger(cb: LogCallback) {
    this.logCallback = cb;
  }

  private log(msg: string) {
    console.log(msg);
    if (this.logCallback) this.logCallback(msg);
  }

  public getIsConnected(): boolean {
    return this.isConnected || this.isSimulating;
  }

  public isSimulationMode(): boolean {
    return this.isSimulating;
  }

  public getDataSnapshot() {
    return this.latestData;
  }

  public async requestMotionPermission(): Promise<boolean> {
      // (Simulation logic kept for fallback)
      if (typeof (DeviceMotionEvent as any) !== 'undefined' && typeof (DeviceMotionEvent as any).requestPermission === 'function') {
        try {
          return await (DeviceMotionEvent as any).requestPermission() === 'granted';
        } catch { return false; }
      }
      return true;
  }

  // --------------------------------------------------------------------------
  // Bluetooth Logic
  // --------------------------------------------------------------------------

  public async connect(): Promise<boolean> {
    if (this.isSimulating) this.stopSimulation();

    if (!navigator.bluetooth) {
      alert("您的浏览器不支持蓝牙 (Web Bluetooth)。请使用 Bluefy (iOS) 或 Chrome (Android/PC)。");
      return false;
    }

    try {
      this.log("开始扫描设备...");
      // 只扫描 Nordic UART 服务，精准命中 SILI 设备
      this.device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [UART_SERVICE_UUID] 
      });

      if (!this.device || !this.device.gatt) return false;

      this.device.addEventListener('gattserverdisconnected', this.onDisconnected.bind(this));
      this.log(`选中设备: ${this.device.name} (ID: ${this.device.id})`);

      this.server = await this.device.gatt.connect();
      this.isConnected = true;
      this.log("GATT 连接成功");

      // 获取 UART 服务
      this.log("正在获取 UART 服务...");
      const service = await this.server.getPrimaryService(UART_SERVICE_UUID);
      
      // 获取特征值
      this.log("正在获取特征值...");
      this.rxChar = await service.getCharacteristic(UART_RX_CHAR_UUID); // 写入通道
      const txChar = await service.getCharacteristic(UART_TX_CHAR_UUID); // 通知通道

      // 订阅通知 (接收数据)
      this.log("订阅数据通知...");
      await txChar.startNotifications();
      txChar.addEventListener('characteristicvaluechanged', this.handleBluetoothData.bind(this));

      // ----------------------------------------------------------------------
      // 执行握手协议
      // ----------------------------------------------------------------------
      await this.performHandshake(this.device.name || "SILI_000000");

      return true;

    } catch (e: any) {
      this.log(`连接失败: ${e.message}`);
      this.disconnect();
      throw e;
    }
  }

  private async performHandshake(deviceName: string) {
      // 1. 解析 ID: SILI_F6A9B4 -> F6 A9 B4
      let idBytes = [0x00, 0x00, 0x00];
      const match = deviceName.match(/([0-9A-F]{6})$/i);
      if (match) {
          const hex = match[1];
          idBytes[0] = parseInt(hex.substring(0, 2), 16);
          idBytes[1] = parseInt(hex.substring(2, 4), 16);
          idBytes[2] = parseInt(hex.substring(4, 6), 16);
          this.log(`识别到 ID: ${hex}`);
      } else {
          this.log("警告: 无法从名称解析 ID，使用默认 000000");
      }

      // 2. 构造指令: AA B0 B0 03 [ID1] [ID2] [ID3] [CRC] BB
      // CRC 计算范围: B0 B0 03 ID1 ID2 ID3 (共6字节)
      const payloadForCrc = [0xB0, 0xB0, 0x03, ...idBytes];
      const crc = calculateCRC8(new Uint8Array(payloadForCrc));
      
      const packet = new Uint8Array([0xAA, ...payloadForCrc, crc, 0xBB]);

      this.log(`发送握手指令: ${Array.from(packet).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ')}`);

      if (this.rxChar) {
          await this.rxChar.writeValue(packet);
          this.log("握手指令已发送，等待数据...");
      } else {
          throw new Error("无法写入: RX 特征值未找到");
      }
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
    this.log("已断开连接");
  }

  private onDisconnected() {
    this.log("设备意外断开");
    this.isConnected = false;
  }

  // --------------------------------------------------------------------------
  // Data Parsing (Binary Protocol)
  // --------------------------------------------------------------------------

  private handleBluetoothData(event: any) {
      const value = event.target.value as DataView;
      // 将新数据追加到 buffer
      for (let i = 0; i < value.byteLength; i++) {
          this.rawBuffer.push(value.getUint8(i));
      }
      this.processRawBuffer();
  }

  private processRawBuffer() {
      // 寻找帧头 AA
      // 最小帧长度: AA F0 ADDR LEN(3) D1 D2 D3 CRC BB = 11 bytes (如果 LEN=3)
      // 通常 LEN 可能更大，例如 3*10=30 bytes
      
      while (this.rawBuffer.length >= 8) { // 至少要有头部和部分数据
          // 1. 查找 Start Byte 0xAA
          const startIdx = this.rawBuffer.indexOf(0xAA);
          
          if (startIdx === -1) {
              // 没找到 AA，清空 Buffer
              this.rawBuffer = [];
              break;
          }

          // 丢弃 AA 之前的垃圾数据
          if (startIdx > 0) {
              this.rawBuffer.splice(0, startIdx);
          }

          // 现在 rawBuffer[0] == 0xAA
          // 检查是否有足够的长度读头部
          if (this.rawBuffer.length < 5) break; // AA FUNC ADDR LEN ...

          const func = this.rawBuffer[1];
          const len = this.rawBuffer[3];
          
          // 预期总帧长: 1(AA) + 1(FUNC) + 1(ADDR) + 1(LEN) + LEN(数据) + 1(CRC) + 1(BB)
          const frameSize = 1 + 1 + 1 + 1 + len + 1 + 1;

          if (this.rawBuffer.length < frameSize) {
              // 数据还没收全，等待下一个包
              break; 
          }

          // 2. 检查帧尾 0xBB
          if (this.rawBuffer[frameSize - 1] !== 0xBB) {
              this.log(`帧尾校验失败 (预期 BB, 实际 ${this.rawBuffer[frameSize-1].toString(16)})，丢弃包头`);
              this.rawBuffer.shift(); // 丢弃 AA，继续找下一个
              continue;
          }

          // 3. (可选) 校验 CRC - 暂时跳过以提高宽容度，如果数据乱可以加上
          // const packetData = this.rawBuffer.slice(1, frameSize - 2); // FUNC ... DATA
          // const receivedCrc = this.rawBuffer[frameSize - 2];
          // const calcCrc = calculateCRC8(new Uint8Array(packetData));
          
          // 4. 解析数据
          if (func === 0xF0) {
              const dataPayload = this.rawBuffer.slice(4, 4 + len); // 从索引4开始，长度len
              this.parseSamples(dataPayload);
          } else if (func === 0xE1) {
              // 电量包，忽略或解析
              // this.log("收到电量包");
          }

          // 5. 移除已处理的帧
          this.rawBuffer.splice(0, frameSize);
      }
  }

  private parseSamples(payload: number[]) {
      // payload 是字节数组，每 3 个字节是一个 24位有符号整数
      // Big-endian usually? PDF doesn't specify but usually MSB first.
      
      for (let i = 0; i < payload.length; i += 3) {
          if (i + 2 >= payload.length) break;

          const b0 = payload[i];
          const b1 = payload[i+1];
          const b2 = payload[i+2];

          // 24-bit Signed Integer (Two's complement)
          let val = (b0 << 16) | (b1 << 8) | b2;
          // Sign extension if 24th bit is 1
          if (val & 0x800000) {
              val = val - 0x1000000;
          }

          // 转换为 uV
          const uv = val * SCALE_FACTOR;
          
          // 信号处理
          this.processSignal(uv);
      }
  }

  private processSignal(uv: number) {
      // 1. 滤波 & 缓存
      const filtered = this.dsp.process(uv);

      // 2. 更新 FFT & 指标 (降频更新，不必每个点都算 FFT)
      // 只有当积累了一定数据，或者每隔 100ms 更新一次 UI 数据
      // 这里为了简单，我们每次采集都更新 latestData，但 UI 那边是定时器取的
      
      // 更新波形
      this.latestData.raw = { timestamp: Date.now(), value: filtered };

      // 3. 计算频段
      const bands = this.dsp.getFFT();
      this.latestData.bands = bands;

      // 4. 计算指标
      const eps = 0.1;
      // 放松指数 (Relaxation): Alpha 优势
      const totalPower = bands.delta + bands.theta + bands.alpha + bands.beta + bands.gamma + eps;
      const relMetric = (bands.alpha + bands.theta) / totalPower; 
      
      // 专注指数 (Attention): Beta/Gamma 优势
      const attMetric = (bands.beta + bands.gamma) / totalPower;

      // 平滑处理 (Exponential Moving Average)
      const prevRel = this.latestData.metrics.relaxation;
      const smoothRel = prevRel * 0.9 + relMetric * 0.1;
      
      const prevAtt = this.latestData.metrics.attention;
      const smoothAtt = prevAtt * 0.9 + attMetric * 0.1;

      const isMeditating = smoothRel > MEDITATION_THRESHOLD;

      this.latestData.metrics = {
          relaxation: smoothRel,
          attention: smoothAtt,
          isMeditating
      };
  }
  
  // --------------------------------------------------------------------------
  // Simulation (Fallback)
  // --------------------------------------------------------------------------
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
    if (!acc) return;
    if (this.lastAcceleration && acc.x && acc.y && acc.z) {
      const delta = Math.abs(acc.x - this.lastAcceleration.x) + Math.abs(acc.y - this.lastAcceleration.y) + Math.abs(acc.z - this.lastAcceleration.z);
      if (delta > 0.5) this.agitationLevel += delta * 5;
    }
    this.lastAcceleration = { x: acc.x || 0, y: acc.y || 0, z: acc.z || 0 };
  }

  private updateSimulation() {
    this.agitationLevel = Math.max(0, this.agitationLevel * 0.9);
    const rel = Math.max(0, 1 - (this.agitationLevel / 50));
    const isMeditating = rel > 0.8;
    
    // Fake FFT
    this.latestData = {
        raw: { timestamp: Date.now(), value: Math.sin(Date.now()/100) * 10 + (Math.random()-0.5)*5 },
        bands: {
            delta: 10, theta: 10, alpha: rel * 50, beta: (1-rel)*30, gamma: 5
        },
        metrics: {
            relaxation: rel,
            attention: 1 - rel,
            isMeditating
        }
    };
  }
}

export const signalProcessor = new DeviceService();
