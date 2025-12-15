import { FrequencyBands, AnalysisMetrics, EEGDataPoint } from '../types';
import { MEDITATION_THRESHOLD } from '../constants';

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

const VERSION = "v2.2 (Nordic UART Fix)";
const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Write
const UART_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Notify

const SCALE_FACTOR = (2.454 / (12 * 8388608)) * 1000000;
const SAMPLE_RATE = 250; 
const FFT_SIZE = 256; 

// --------------------------------------------------------------------------
// Types
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
    getPrimaryServices(): Promise<BluetoothRemoteGATTService[]>;
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
// Helpers
// --------------------------------------------------------------------------

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
        // DC Blocker
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
        
        const windowed = this.buffer.map((v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))));
        const mags = new Float32Array(FFT_SIZE / 2);
        
        // Simple DFT for key bands (Optimization: could use FFT lib if needed)
        // Since we only need specific bands, we could run Goertzel, but full DFT/FFT on 256 pts is fast enough in JS
        for (let k = 0; k < FFT_SIZE / 2; k++) {
             let real = 0; let imag = 0;
             for (let n = 0; n < FFT_SIZE; n++) {
                 const theta = -2 * Math.PI * k * n / FFT_SIZE;
                 real += windowed[n] * Math.cos(theta);
                 imag += windowed[n] * Math.sin(theta);
             }
             mags[k] = Math.sqrt(real * real + imag * imag);
        }
        
        const res = SAMPLE_RATE / FFT_SIZE;
        const getPower = (minHz: number, maxHz: number) => {
            const minBin = Math.floor(minHz / res);
            const maxBin = Math.ceil(maxHz / res);
            let sum = 0;
            for(let i=minBin; i<=maxBin && i < mags.length; i++) sum += mags[i];
            return sum / (Math.max(1, maxBin - minBin));
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
  // Connect Logic
  // --------------------------------------------------------------------------

  public async connect(): Promise<boolean> {
    if (this.isSimulating) this.stopSimulation();

    if (!navigator.bluetooth) {
      alert("请使用支持 Web Bluetooth 的浏览器 (如 Bluefy)。");
      return false;
    }

    try {
      this.log(`正在初始化 ${VERSION}...`);
      
      // 策略：优先使用过滤器匹配 SILI 设备，并显式要求 UART 服务
      // 这可以避免 iOS 扫描到无关设备，也确保我们有权限访问 6e40 服务
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'SILI' }], 
        optionalServices: [UART_SERVICE_UUID] 
      });

      if (!this.device || !this.device.gatt) return false;

      this.device.addEventListener('gattserverdisconnected', this.onDisconnected.bind(this));
      this.log(`设备已选择: ${this.device.name}`);

      this.server = await this.device.gatt.connect();
      this.isConnected = true;
      this.log("GATT 连接成功，正在查找服务...");

      // 显式查找 Nordic UART 服务
      // 注意：这会忽略 Battery Service (180f)，从而解决连接到 2A19 的问题
      let service: BluetoothRemoteGATTService;
      try {
          service = await this.server.getPrimaryService(UART_SERVICE_UUID);
          this.log(`已找到 UART 服务: ${service.uuid}`);
      } catch (e) {
          // 如果直接查找失败，列出所有服务以供调试
          try {
             const allServices = await this.server.getPrimaryServices();
             this.log(`未找到 UART 服务。可用服务: ${allServices.map(s => s.uuid).join(', ')}`);
          } catch(err) {}
          throw new Error("设备不支持 UART 数据传输服务 (6E40...)");
      }

      this.log("正在获取读写特征值...");
      this.rxChar = await service.getCharacteristic(UART_RX_CHAR_UUID); 
      const txChar = await service.getCharacteristic(UART_TX_CHAR_UUID); 

      this.log(`开启通知: ${UART_TX_CHAR_UUID}`);
      await txChar.startNotifications();
      txChar.addEventListener('characteristicvaluechanged', this.handleBluetoothData.bind(this));

      // 握手
      await this.performHandshake(this.device.name || "SILI_000000");
      
      return true;

    } catch (e: any) {
      this.log(`连接错误: ${e.message}`);
      this.disconnect();
      throw e;
    }
  }

  private async performHandshake(deviceName: string) {
      // 解析 ID: SILI_F6A9B4 -> F6 A9 B4
      let idBytes = [0x00, 0x00, 0x00];
      const match = deviceName.match(/([0-9A-F]{6})$/i);
      if (match) {
          const hex = match[1];
          idBytes[0] = parseInt(hex.substring(0, 2), 16);
          idBytes[1] = parseInt(hex.substring(2, 4), 16);
          idBytes[2] = parseInt(hex.substring(4, 6), 16);
      } else {
          this.log("警告: 无法从名称解析 ID，使用默认 00-00-00");
      }

      // 指令: AA B0 B0 03 [ID1] [ID2] [ID3] [CRC] BB
      const payloadForCrc = [0xB0, 0xB0, 0x03, ...idBytes];
      const crc = calculateCRC8(new Uint8Array(payloadForCrc));
      const packet = new Uint8Array([0xAA, ...payloadForCrc, crc, 0xBB]);

      const hexStr = Array.from(packet).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
      this.log(`TX >>> 握手指令: ${hexStr}`);

      if (this.rxChar) {
          await this.rxChar.writeValue(packet);
          this.log("指令已发送，等待设备响应...");
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
    this.log("断开连接");
  }

  private onDisconnected() {
    this.log("设备连接断开");
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
      // 帧结构: AA (Header) + ... + BB (Tail)
      // 处理粘包和分包
      while (this.rawBuffer.length > 0) {
          // 1. 寻找帧头 AA
          const startIdx = this.rawBuffer.indexOf(0xAA);
          if (startIdx === -1) {
              this.rawBuffer = []; // 没有头，丢弃所有
              return;
          }
          if (startIdx > 0) {
              this.rawBuffer.splice(0, startIdx); // 丢弃头部前面的垃圾
          }

          // 2. 检查长度是否足以读取 FUNC 和 LEN
          // Min size: AA FUNC ADDR LEN ... (at least 4 bytes to know length)
          if (this.rawBuffer.length < 4) return; // 等待更多数据

          const len = this.rawBuffer[3];
          // 全帧长: AA(1) + FUNC(1) + ADDR(1) + LEN(1) + PAYLOAD(len) + CRC(1) + BB(1)
          const frameSize = 6 + len; 

          if (this.rawBuffer.length < frameSize) return; // 等待更多数据

          // 3. 验证帧尾 BB
          if (this.rawBuffer[frameSize - 1] !== 0xBB) {
              this.log(`帧校验错误: 尾部不是 BB (是 ${this.rawBuffer[frameSize - 1].toString(16)})`);
              this.rawBuffer.shift(); // 移动一位，重新寻找 AA
              continue; 
          }

          // 4. 提取数据
          const func = this.rawBuffer[1];
          const payload = this.rawBuffer.slice(4, 4 + len);
          
          if (func === 0xF0) {
              // 脑电数据
              this.parseSamples(payload);
          } else {
              // 其他指令 (如电量 0xE1)
              // this.log(`RX: FUNC=${func.toString(16)} LEN=${len}`);
          }

          // 5. 移除已处理帧
          this.rawBuffer.splice(0, frameSize);
      }
  }

  private parseSamples(payload: number[]) {
      // 3 bytes per sample (24-bit big endian)
      for (let i = 0; i < payload.length; i += 3) {
          if (i + 2 >= payload.length) break;
          
          let val = (payload[i] << 16) | (payload[i+1] << 8) | payload[i+2];
          // Sign extension
          if (val & 0x800000) val = val - 0x1000000;
          
          const uv = val * SCALE_FACTOR;
          this.processSignal(uv);
      }
  }

  private processSignal(uv: number) {
      const filtered = this.dsp.process(uv);
      
      this.latestData.raw = { timestamp: Date.now(), value: filtered };
      
      // 这里的逻辑可以优化：不需要每个点都算 FFT
      // 但为了演示流畅性，我们让 getFFT 内部决定是否返回缓存值
      // 简单起见，这里总是计算
      const bands = this.dsp.getFFT();
      
      const eps = 0.1;
      const totalPower = bands.delta + bands.theta + bands.alpha + bands.beta + bands.gamma + eps;
      const relMetric = (bands.alpha + bands.theta) / totalPower; 
      const attMetric = (bands.beta + bands.gamma) / totalPower;

      // 平滑
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
  // Simulation Logic
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
    this.log("已启动模拟模式");
  }

  public stopSimulation() {
    this.isSimulating = false;
    window.removeEventListener('devicemotion', this.handleMotion);
    if (this.simulationInterval) clearInterval(this.simulationInterval);
    this.simulationInterval = null;
    this.log("已停止模拟");
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
    
    // Fake data
    this.latestData = {
        raw: { timestamp: Date.now(), value: Math.sin(Date.now()/50)*10 + (Math.random()-0.5)*5 },
        bands: { delta: 5, theta: 5, alpha: rel*40, beta: (1-rel)*20, gamma: 5 },
        metrics: { relaxation: rel, attention: 1-rel, isMeditating: rel > 0.8 }
    };
  }
}

export const signalProcessor = new DeviceService();
