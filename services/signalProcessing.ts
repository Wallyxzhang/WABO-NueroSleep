import { FrequencyBands, AnalysisMetrics, EEGDataPoint } from '../types';
import { MEDITATION_THRESHOLD } from '../constants';

// Define Web Serial API types locally
declare global {
  interface Navigator {
    serial: Serial;
    bluetooth: Bluetooth;
  }
  interface Serial {
    requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
    getPorts(): Promise<SerialPort[]>;
  }
  interface SerialPortRequestOptions {
    filters?: SerialPortFilter[];
  }
  interface SerialPortFilter {
    usbVendorId?: number;
    usbProductId?: number;
  }
  interface SerialPort {
    readable: ReadableStream<Uint8Array> | null;
    writable: WritableStream<Uint8Array> | null;
    open(options: SerialOptions): Promise<void>;
    close(): Promise<void>;
  }
  interface SerialOptions {
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: 'none' | 'even' | 'odd';
    bufferSize?: number;
    flowControl?: 'none' | 'hardware';
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
    name?: string;
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
    getCharacteristics(): Promise<BluetoothRemoteGATTCharacteristic[]>;
  }
  interface BluetoothRemoteGATTCharacteristic {
    uuid: string;
    properties: { notify: boolean; indicate: boolean; write: boolean; read: boolean };
    startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
    stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
    addEventListener(type: string, listener: (event: any) => void): void;
    value?: DataView;
  }
}

// 您的设备特定 UUID
const TARGET_SERVICE_UUID = '208ca0ee-8496-d491-c6a0-49a7cbbd6b41'; 

const COMMON_BLE_SERVICES = [
    TARGET_SERVICE_UUID,                    // 您的设备
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
    '0000ffe0-0000-1000-8000-00805f9b34fb', // HM-10 / CC2541 / HC-08 / JDY
    '00001800-0000-1000-8000-00805f9b34fb', // Generic Access
    '00001801-0000-1000-8000-00805f9b34fb', // Generic Attribute
    '0000dfb0-0000-1000-8000-00805f9b34fb', // Bluno
    '0000fe59-0000-1000-8000-00805f9b34fb', // Nordic (Legacy)
];

export type LogCallback = (msg: string) => void;

export class DeviceService {
  // Serial
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  
  // Bluetooth
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  
  private isConnected: boolean = false;
  private inputBuffer: string = "";
  
  // Debug Logging
  private logCallback: LogCallback | null = null;
  
  // Simulation State
  private isSimulating: boolean = false;
  private agitationLevel: number = 0;
  private lastAcceleration: { x: number, y: number, z: number } | null = null;
  private simulationInterval: number | null = null;
  
  private latestData: { 
    raw: EEGDataPoint, 
    bands: FrequencyBands, 
    metrics: AnalysisMetrics 
  } = {
    raw: { timestamp: 0, value: 0 },
    bands: { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 },
    metrics: { attention: 0, relaxation: 0, isMeditating: false }
  };

  constructor() {}

  // 设置日志回调，用于 UI 显示
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

  public async requestMotionPermission(): Promise<boolean> {
    if (typeof (DeviceMotionEvent as any) !== 'undefined' && typeof (DeviceMotionEvent as any).requestPermission === 'function') {
      try {
        const permissionState = await (DeviceMotionEvent as any).requestPermission();
        return permissionState === 'granted';
      } catch (error) {
        console.error("Motion permission error:", error);
        return false;
      }
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
    if (this.simulationInterval) {
      clearInterval(this.simulationInterval);
      this.simulationInterval = null;
    }
    this.lastAcceleration = null;
    this.latestData = {
        raw: { timestamp: 0, value: 0 },
        bands: { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 },
        metrics: { attention: 0, relaxation: 0, isMeditating: false }
    };
    this.log("模拟模式已停止");
  }

  private handleMotion = (event: DeviceMotionEvent) => {
    const acc = event.accelerationIncludingGravity;
    if (!acc || acc.x === null || acc.y === null || acc.z === null) return;
    if (this.lastAcceleration) {
      const delta = Math.abs(acc.x - this.lastAcceleration.x) + 
                    Math.abs(acc.y - this.lastAcceleration.y) + 
                    Math.abs(acc.z - this.lastAcceleration.z);
      if (delta > 0.5) {
        this.agitationLevel += delta * 5; 
      }
    }
    this.lastAcceleration = { x: acc.x, y: acc.y, z: acc.z };
  }

  private updateSimulation() {
    this.agitationLevel = Math.max(0, this.agitationLevel * 0.9);
    const normalizedAgitation = Math.min(this.agitationLevel / 30, 1);
    const targetRelaxation = 1 - normalizedAgitation;
    const prevRelaxation = this.latestData.metrics.relaxation || 0.5;
    const relaxation = prevRelaxation * 0.8 + targetRelaxation * 0.2;
    const attention = 1 - relaxation;
    const isMeditating = relaxation > MEDITATION_THRESHOLD;
    const random = () => Math.random();
    const alpha = (relaxation * 40) + 10 + (random() * 5); 
    const beta = (attention * 30) + 5 + (random() * 5);
    const theta = 10 + random() * 5;
    const delta = 5 + random() * 5;
    const gamma = (attention * 20) + random() * 5;
    const t = Date.now() / 1000;
    let rawValue = 0;
    if (isMeditating) {
        rawValue = Math.sin(t * 10 * Math.PI * 2) * 50 + (random() * 10);
    } else {
        rawValue = Math.sin(t * 25 * Math.PI * 2) * 20 + (random() * 40 - 20);
    }
    this.latestData = {
        raw: { timestamp: Date.now(), value: rawValue },
        bands: { delta, theta, alpha, beta, gamma },
        metrics: { attention, relaxation, isMeditating }
    };
  }

  // --------------------------------------------------------------------------
  // 连接逻辑
  // --------------------------------------------------------------------------
  
  public async connect(): Promise<boolean> {
    if (this.isSimulating) {
        this.stopSimulation();
    }
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    
    if (navigator.serial && !isMobile) {
        try {
            this.log("尝试 Web Serial...");
            return await this.connectSerial();
        } catch (e) {
            this.log("Serial 取消，尝试蓝牙...");
        }
    }

    if (navigator.bluetooth) {
        this.log("启动蓝牙扫描...");
        try {
            return await this.connectBluetooth();
        } catch (e: any) {
            this.log(`蓝牙错误: ${e.message}`);
            throw e; 
        }
    } else {
        this.log("错误: 浏览器不支持蓝牙或串口");
        return false;
    }
  }

  // ----------------------
  // Web Serial
  // ----------------------
  private async connectSerial(): Promise<boolean> {
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: 115200 });
      this.isConnected = true;
      this.log("Serial 已连接");
      this.readSerialLoop();
      return true;
  }

  private async readSerialLoop() {
    if (!this.port || !this.port.readable) return;
    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
    this.reader = textDecoder.readable.getReader();

    try {
      while (true) {
        if (!this.reader) break;
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          // Serial data is almost always text, but we log it just in case
          // this.log(`Serial RX: ${value.substring(0, 20)}...`); 
          this.inputBuffer += value;
          this.processBuffer();
        }
      }
    } catch (error) {
      console.error("Serial error:", error);
    } finally {
      if (this.reader) this.reader.releaseLock();
      this.isConnected = false;
    }
  }

  // ----------------------
  // Web Bluetooth
  // ----------------------
  private async connectBluetooth(): Promise<boolean> {
      // 这里的 filters 设置非常关键
      // 我们显式请求您的设备 UUID 和 'SILI' 前缀
      this.device = await navigator.bluetooth.requestDevice({
          // filters: [{ namePrefix: 'SILI' }], // 如果加上 filter 可能更精准，但有时候如果不匹配会导致搜不到
          acceptAllDevices: true, 
          optionalServices: [...COMMON_BLE_SERVICES]
      });

      if (!this.device || !this.device.gatt) return false;

      this.device.addEventListener('gattserverdisconnected', this.onDisconnected.bind(this));

      this.log(`连接设备: ${this.device.name} (${this.device.id})`);
      this.server = await this.device.gatt.connect();
      this.isConnected = true;
      this.log("GATT Server 已连接");

      const services = await this.server.getPrimaryServices();
      let foundCharacteristic = false;
      
      const foundServiceUUIDs = services.map(s => s.uuid);
      this.log(`发现服务: ${foundServiceUUIDs.join('\n')}`);

      for (const service of services) {
          try {
            const characteristics = await service.getCharacteristics();
            for (const char of characteristics) {
                this.log(`>> 特征值: ${char.uuid.substring(0,8)}... [N:${char.properties.notify}, I:${char.properties.indicate}, R:${char.properties.read}, W:${char.properties.write}]`);
                
                // 优先匹配 Notify 或 Indicate
                if (char.properties.notify || char.properties.indicate) {
                    this.log(`>>> 正在订阅特征值: ${char.uuid}`);
                    
                    await char.startNotifications();
                    char.addEventListener('characteristicvaluechanged', this.handleBluetoothData.bind(this));
                    
                    foundCharacteristic = true;
                    // 我们不 break，因为可能想订阅多个，或者为了保险起见订阅所有 notify
                    // 但通常一个就够了。为了调试，我们只订阅找到的第一个。
                    break; 
                }
            }
          } catch(e) {
              console.warn(e);
          }
          if (foundCharacteristic) break;
      }

      if (!foundCharacteristic) {
          this.disconnect();
          throw new Error(`未找到数据通道。\n服务: ${foundServiceUUIDs.join(', ')}`);
      }

      this.log("正在监听数据...");
      return true;
  }

  private handleBluetoothData(event: any) {
      const value = event.target.value as DataView;
      
      // 调试：打印原始 Hex 数据
      // 如果您发现控制台输出了类似 "Raw Hex: 0x01 0x0A ..." 的内容，说明连接没问题，是解析问题
      let hex = '';
      for(let i=0; i<Math.min(value.byteLength, 10); i++) {
        hex += '0x' + value.getUint8(i).toString(16).padStart(2, '0') + ' ';
      }
      if (value.byteLength > 10) hex += '...';
      
      const decoder = new TextDecoder('utf-8');
      const text = decoder.decode(value);
      
      // 在控制台输出调试信息 (频率较高，仅在调试时看)
      // console.log(`RX [${value.byteLength}]: ${hex} | Text: ${text.substring(0, 20)}`);
      
      // 如果数据里包含不可见字符，可能是二进制格式，而非纯文本
      // 我们可以把这个 rawText 传给 UI 显示
      
      this.inputBuffer += text;
      this.processBuffer();
  }

  private onDisconnected() {
      this.log("设备连接已断开");
      this.isConnected = false;
      this.device = null;
      this.server = null;
  }

  public async disconnect() {
    if (this.isSimulating) {
        this.stopSimulation();
        return;
    }
    if (this.reader) await this.reader.cancel();
    if (this.port) await this.port.close();
    this.port = null;
    this.reader = null;
    if (this.server && this.server.connected) this.server.disconnect();
    this.device = null;
    this.server = null;
    this.isConnected = false;
  }

  private processBuffer() {
    let buffer = this.inputBuffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!buffer.includes('\n')) {
        this.inputBuffer = buffer;
        return;
    }
    const lines = buffer.split('\n');
    this.inputBuffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim().length > 0) {
        this.parseDataPacket(line.trim());
      }
    }
  }

  private parseDataPacket(line: string) {
    try {
      // 简单验证：必须包含逗号，或者是数字
      if (!line.includes(',') && isNaN(Number(line))) {
          // 这可能是一条状态消息，或者乱码
          // this.log(`Ignored line: ${line}`);
          return;
      }

      const cleanLine = line.replace(/[^0-9.,-]/g, '');
      const parts = cleanLine.split(',');
      
      if (parts.length >= 5) {
        const bands: FrequencyBands = {
          delta: parseFloat(parts[0]) || 0,
          theta: parseFloat(parts[1]) || 0,
          alpha: parseFloat(parts[2]) || 0,
          beta: parseFloat(parts[3]) || 0,
          gamma: parseFloat(parts[4]) || 0,
        };

        const rawValue = parts.length > 5 ? parseFloat(parts[5]) : 0;
        const eps = 0.0001;
        const relaxation = bands.alpha / (bands.beta + bands.theta + eps);
        const attention = bands.beta / (bands.alpha + bands.theta + eps);
        const isMeditating = relaxation > MEDITATION_THRESHOLD;

        this.latestData = {
          raw: { timestamp: Date.now(), value: rawValue },
          bands,
          metrics: { attention, relaxation, isMeditating }
        };
      } else {
          // 如果分割出来的数据不足5个，可能是格式不对
          this.log(`数据解析警告: 字段不足 (预期>5, 实际${parts.length})。原始内容: ${line.substring(0, 30)}`);
      }
    } catch (e) {
       this.log(`解析错误: ${e}`);
    }
  }

  public getDataSnapshot() {
    return this.latestData;
  }
}

export const signalProcessor = new DeviceService();