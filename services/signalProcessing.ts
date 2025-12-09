import { FrequencyBands, AnalysisMetrics, EEGDataPoint } from '../types';
import { MEDITATION_THRESHOLD } from '../constants';

// Define Web Serial API types locally as they might not be in the global TS scope
declare global {
  interface Navigator {
    serial: Serial;
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
}

// 此服务负责通过 Web Serial API 直接与设备通信
// 对应 Matlab 程序中的串口读取与数据处理逻辑
// 我们通过蓝牙转串口 (Bluetooth Serial) 适配器读取数据

export class DeviceService {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
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
      
      // Increase agitation based on movement intensity
      // Sensitivity factor can be adjusted
      this.agitationLevel += delta * 2; 
    }
    this.lastAcceleration = { x: acc.x, y: acc.y, z: acc.z };
  }

  // Generate simulated EEG data based on agitation
  private updateSimulation() {
    // Decay agitation over time (return to calm state)
    this.agitationLevel = Math.max(0, this.agitationLevel * 0.9);
    
    // Map agitation to relaxation (0-100 scale mapped to 1.0-0.0)
    // Agitation 0 (Flat) -> Relaxation 1.0
    // Agitation High (Shaking) -> Relaxation Low
    const normalizedAgitation = Math.min(this.agitationLevel / 15, 1);
    const targetRelaxation = 1 - normalizedAgitation;
    
    // Smooth transition for realistic sensor lag feel
    const prevRelaxation = this.latestData.metrics.relaxation || 0.5;
    const relaxation = prevRelaxation * 0.8 + targetRelaxation * 0.2;
    
    const attention = 1 - relaxation;
    const isMeditating = relaxation > MEDITATION_THRESHOLD;

    // Generate Frequency Bands based on state
    // Relaxed: High Alpha (8-14Hz), Low Beta
    // Stressed/Active: Low Alpha, High Beta (12-30Hz), High Gamma
    
    const random = () => Math.random();

    const alpha = (relaxation * 40) + 10 + (random() * 5); 
    const beta = (attention * 30) + 5 + (random() * 5);
    const theta = 10 + random() * 5;
    const delta = 5 + random() * 5;
    const gamma = (attention * 20) + random() * 5;

    // Generate Raw Waveform
    // Meditating: Higher amplitude, slower frequency (Alpha-ish)
    // Agitated: Lower amplitude fast noise (Beta/Gamma)
    const t = Date.now() / 1000;
    
    let rawValue = 0;
    if (isMeditating) {
        // Alpha wave dominance (10Hz approx)
        rawValue = Math.sin(t * 10 * Math.PI * 2) * 50 + (random() * 10);
    } else {
        // Beta/Gamma noise
        rawValue = Math.sin(t * 25 * Math.PI * 2) * 20 + (random() * 40 - 20);
    }

    this.latestData = {
        raw: { timestamp: Date.now(), value: rawValue },
        bands: { delta, theta, alpha, beta, gamma },
        metrics: { attention, relaxation, isMeditating }
    };
  }

  // 连接到串口设备 (蓝牙转串口)
  public async connect(): Promise<boolean> {
    // If simulating, stop simulation first
    if (this.isSimulating) {
        this.stopSimulation();
    }

    try {
      if (!navigator.serial) {
        console.error("Web Serial API is not supported in this browser.");
        return false;
      }

      // 请求用户选择串口
      this.port = await navigator.serial.requestPort();
      
      // 打开串口，波特率需与硬件设备匹配 (通常为 9600, 57600 或 115200)
      // 这里假设为 115200，如果您的 Matlab 程序中使用的是其他波特率，请在此修改
      await this.port.open({ baudRate: 115200 });
      
      this.isConnected = true;
      
      // 开始读取数据循环
      this.readLoop();
      return true;
    } catch (error) {
      console.error("连接设备失败:", error);
      // Even if failed, we return false so UI can handle it (maybe suggest simulation)
      return false;
    }
  }

  // 断开连接
  public async disconnect() {
    if (this.isSimulating) {
        this.stopSimulation();
        return;
    }

    if (this.reader) {
      await this.reader.cancel();
    }
    if (this.port) {
      await this.port.close();
    }
    this.isConnected = false;
    this.port = null;
    this.reader = null;
  }

  // 内部读取循环
  private async readLoop() {
    if (!this.port || !this.port.readable) return;

    // @ts-ignore: TextDecoderStream is available in modern browsers supporting Web Serial
    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
    this.reader = textDecoder.readable.getReader();

    try {
      while (true) {
        if (!this.reader) break;
        const { value, done } = await this.reader.read();
        if (done) {
          // 串口关闭
          break;
        }
        if (value) {
          this.inputBuffer += value;
          this.processBuffer();
        }
      }
    } catch (error) {
      console.error("读取错误:", error);
    } finally {
      if (this.reader) {
        this.reader.releaseLock();
      }
      this.isConnected = false;
    }
  }

  // 处理接收到的字符串缓冲区
  private processBuffer() {
    // 假设数据是以换行符分隔的
    const lines = this.inputBuffer.split('\n');
    
    // 保留最后一个可能不完整的片段在缓冲区中
    this.inputBuffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim().length > 0) {
        this.parseDataPacket(line.trim());
      }
    }
  }

  // 解析数据包
  // 请在此处参照您的 Matlab 代码逻辑进行调整
  // 假设设备发送的数据格式为 CSV: "delta,theta,alpha,beta,gamma,raw_eeg"
  // 或者 JSON 格式
  private parseDataPacket(line: string) {
    try {
      // 尝试解析 CSV 格式 (示例: 12.5, 4.3, 20.1, 8.5, 2.1, 55)
      // 如果您的设备协议不同，请修改此处的解析逻辑
      const parts = line.split(',');
      
      // 简单的健壮性检查
      if (parts.length >= 5) {
        const bands: FrequencyBands = {
          delta: parseFloat(parts[0]) || 0,
          theta: parseFloat(parts[1]) || 0,
          alpha: parseFloat(parts[2]) || 0,
          beta: parseFloat(parts[3]) || 0,
          gamma: parseFloat(parts[4]) || 0,
        };

        const rawValue = parts.length > 5 ? parseFloat(parts[5]) : 0;

        // 计算指标 (参照 Matlab 算法)
        // 放松指数 = Alpha / (Beta + Theta)
        const eps = 0.0001;
        const relaxation = bands.alpha / (bands.beta + bands.theta + eps);
        // 专注指数 = Beta / (Alpha + Theta)
        const attention = bands.beta / (bands.alpha + bands.theta + eps);
        
        const isMeditating = relaxation > MEDITATION_THRESHOLD;

        // 更新最新状态
        this.latestData = {
          raw: { timestamp: Date.now(), value: rawValue },
          bands,
          metrics: { attention, relaxation, isMeditating }
        };
      }
    } catch (e) {
      console.warn("解析数据包失败:", line, e);
    }
  }

  // 供 UI 调用的公共方法，获取当前最新的数据快照
  // 如果没有连接设备，这里可以返回模拟数据用于演示，或者返回空值
  public getDataSnapshot() {
    // Whether connected via serial OR simulation, we return the data
    return this.latestData;
  }
}

export const signalProcessor = new DeviceService();