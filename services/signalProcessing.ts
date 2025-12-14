
import { FrequencyBands, AnalysisMetrics, EEGDataPoint } from '../types';
import { MEDITATION_THRESHOLD } from '../constants';

// Define Web Serial API types locally as they might not be in the global TS scope
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

  // Web Bluetooth Types
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

// Common BLE UART Service UUIDs to try automatically
const BLE_UART_SERVICES = [
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
    '0000ffe0-0000-1000-8000-00805f9b34fb', // HM-10
];

export class DeviceService {
  // Serial
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  
  // Bluetooth
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  
  private isConnected: boolean = false;
  private inputBuffer: string = "";
  
  // Simulation State
  private isSimulating: boolean = false;
  private agitationLevel: number = 0;
  private lastAcceleration: { x: number, y: number, z: number } | null = null;
  private simulationInterval: number | null = null;
  
  // 缓存最新的数据帧，供 UI 定时获取
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

  // 获取连接状态
  public getIsConnected(): boolean {
    return this.isConnected || this.isSimulating;
  }

  public isSimulationMode(): boolean {
    return this.isSimulating;
  }

  // Request permission for Device Motion (iOS 13+)
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

  // Start Simulation Mode
  public startSimulation() {
    if (this.isConnected) this.disconnect();
    
    this.isSimulating = true;
    this.agitationLevel = 0;
    
    // Listen to motion
    window.addEventListener('devicemotion', this.handleMotion);
    
    // Start data generation loop
    if (this.simulationInterval) clearInterval(this.simulationInterval);
    this.simulationInterval = window.setInterval(() => this.updateSimulation(), 100);
  }

  // Stop Simulation Mode
  public stopSimulation() {
    this.isSimulating = false;
    window.removeEventListener('devicemotion', this.handleMotion);
    
    if (this.simulationInterval) {
      clearInterval(this.simulationInterval);
      this.simulationInterval = null;
    }
    
    this.lastAcceleration = null;
    
    // Reset data
    this.latestData = {
        raw: { timestamp: 0, value: 0 },
        bands: { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 },
        metrics: { attention: 0, relaxation: 0, isMeditating: false }
    };
  }

  // Handle device motion to calculate agitation/stability
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

  // Generate simulated EEG data based on agitation
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
  // 连接逻辑：自动判断 Serial (PC/USB) 或 Bluetooth (Mobile/Wireless)
  // --------------------------------------------------------------------------
  
  public async connect(): Promise<boolean> {
    if (this.isSimulating) {
        this.stopSimulation();
    }

    // 1. 优先检查是否支持 Web Serial (通常是桌面端 Chrome/Edge)
    // 且不是移动设备 (移动设备即使有 Serial API 通常也需要 OTG，这里优先用蓝牙)
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    
    if (navigator.serial && !isMobile) {
        try {
            console.log("尝试使用 Web Serial 连接...");
            return await this.connectSerial();
        } catch (e) {
            console.warn("Serial 连接失败或被用户取消，尝试蓝牙...", e);
            // 如果 Serial 失败，继续尝试蓝牙
        }
    }

    // 2. 尝试 Web Bluetooth (iOS/Android/Desktop)
    if (navigator.bluetooth) {
        console.log("尝试使用 Web Bluetooth 连接...");
        try {
            return await this.connectBluetooth();
        } catch (e) {
            console.error("蓝牙连接失败:", e);
            return false;
        }
    } else {
        console.error("当前浏览器不支持 Web Serial 也不支持 Web Bluetooth。");
        return false;
    }
  }

  // ----------------------
  // Web Serial Implementation
  // ----------------------
  private async connectSerial(): Promise<boolean> {
      // 请求用户选择串口
      this.port = await navigator.serial.requestPort();
      // 打开串口
      await this.port.open({ baudRate: 115200 });
      this.isConnected = true;
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
          this.inputBuffer += value;
          this.processBuffer();
        }
      }
    } catch (error) {
      console.error("Serial 读取错误:", error);
    } finally {
      if (this.reader) this.reader.releaseLock();
      this.isConnected = false;
    }
  }

  // ----------------------
  // Web Bluetooth Implementation
  // ----------------------
  private async connectBluetooth(): Promise<boolean> {
      // 扫描设备
      // 注意：acceptAllDevices: true 必须配合 optionalServices 使用才能访问特定服务
      // 如果不知道设备的具体 Service UUID，这种方式最通用，但可能需要用户手动选择正确的设备
      this.device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: [...BLE_UART_SERVICES] 
      });

      if (!this.device || !this.device.gatt) return false;

      // 监听断开
      this.device.addEventListener('gattserverdisconnected', this.onDisconnected.bind(this));

      // 连接 GATT Server
      this.server = await this.device.gatt.connect();
      console.log("蓝牙设备已连接:", this.device.name);
      
      this.isConnected = true;

      // 发现服务和特征值
      // 我们遍历所有服务，寻找具有 Notify 属性的特征值
      const services = await this.server.getPrimaryServices();
      let foundCharacteristic = false;

      for (const service of services) {
          try {
            const characteristics = await service.getCharacteristics();
            for (const char of characteristics) {
                if (char.properties.notify) {
                    console.log(`找到通知特征值: ${char.uuid}`);
                    await char.startNotifications();
                    char.addEventListener('characteristicvaluechanged', this.handleBluetoothData.bind(this));
                    foundCharacteristic = true;
                    // 我们假设只需监听第一个找到的 notify 特征值即可
                    // 如果 SW3011 有多个，可能需要更精确的 UUID 匹配
                    break;
                }
            }
          } catch(e) {
              console.warn(`无法访问服务 ${service.uuid} 的特征值`, e);
          }
          if (foundCharacteristic) break;
      }

      if (!foundCharacteristic) {
          console.error("未在设备上找到可用的 Notify 特征值 (SPP/UART)。");
          this.disconnect();
          return false;
      }

      return true;
  }

  private handleBluetoothData(event: any) {
      const value = event.target.value as DataView;
      const decoder = new TextDecoder('utf-8');
      const text = decoder.decode(value);
      
      // 蓝牙数据通常是分包的，我们将其追加到缓冲区
      this.inputBuffer += text;
      this.processBuffer();
  }

  private onDisconnected() {
      console.log("设备已断开");
      this.isConnected = false;
      this.device = null;
      this.server = null;
  }

  // ----------------------
  // Common Logic
  // ----------------------

  public async disconnect() {
    if (this.isSimulating) {
        this.stopSimulation();
        return;
    }

    // Disconnect Serial
    if (this.reader) {
      await this.reader.cancel();
    }
    if (this.port) {
      await this.port.close();
    }
    this.port = null;
    this.reader = null;

    // Disconnect Bluetooth
    if (this.server && this.server.connected) {
        this.server.disconnect();
    }
    this.device = null;
    this.server = null;

    this.isConnected = false;
  }

  // 处理接收到的字符串缓冲区 (Serial & Bluetooth 通用)
  private processBuffer() {
    // 兼容不同的换行符
    let buffer = this.inputBuffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // 如果没有换行符，说明数据还没收完，等待下一次
    if (!buffer.includes('\n')) {
        this.inputBuffer = buffer; // 更新清理后的 buffer
        return;
    }

    const lines = buffer.split('\n');
    
    // 保留最后一个可能不完整的片段
    this.inputBuffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim().length > 0) {
        this.parseDataPacket(line.trim());
      }
    }
  }

  // 解析数据包
  // 预期格式 CSV: "delta,theta,alpha,beta,gamma,raw_eeg"
  private parseDataPacket(line: string) {
    try {
      // 移除潜在的乱码或空格
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

        // 计算指标
        const eps = 0.0001;
        const relaxation = bands.alpha / (bands.beta + bands.theta + eps);
        const attention = bands.beta / (bands.alpha + bands.theta + eps);
        const isMeditating = relaxation > MEDITATION_THRESHOLD;

        this.latestData = {
          raw: { timestamp: Date.now(), value: rawValue },
          bands,
          metrics: { attention, relaxation, isMeditating }
        };
      }
    } catch (e) {
      // 忽略解析错误 (可能是蓝牙连接初期的数据碎片)
    }
  }

  public getDataSnapshot() {
    return this.latestData;
  }
}

export const signalProcessor = new DeviceService();
