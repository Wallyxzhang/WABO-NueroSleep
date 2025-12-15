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

const VERSION = "v2.7 (CRC Check & AutoStart)";
const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // 写入特征 (Write)
const UART_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // 通知特征 (Notify)

// ADS1299 转换系数 (Gain=24, Vref=4.5V/2?) 
// 根据硬件不同可能需要微调，目前保持原设定
const SCALE_FACTOR = (2.454 / (12 * 8388608)) * 1000000;
const SAMPLE_RATE = 250; 
const FFT_SIZE = 256; 

// --------------------------------------------------------------------------
// 辅助函数
// --------------------------------------------------------------------------

export type LogCallback = (msg: string) => void;

/**
 * 计算 CRC8 校验码
 * 用于验证数据包的完整性
 */
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

/**
 * 信号处理器
 * 负责滤波和 FFT 变换
 */
class SignalProcessor {
    private buffer: number[] = [];
    private prevInput: number = 0;
    private prevOutput: number = 0;

    // 预处理：去直流漂移 (High-pass filter)
    process(sample: number): number {
        const output = sample - this.prevInput + 0.995 * this.prevOutput;
        this.prevInput = sample;
        this.prevOutput = output;
        
        this.buffer.push(output);
        if (this.buffer.length > FFT_SIZE) {
            this.buffer.shift();
        }
        return output;
    }

    // 计算 FFT 频谱能量
    getFFT(): FrequencyBands {
        if (this.buffer.length < FFT_SIZE) return { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
        
        // 汉宁窗 (Hanning Window) - 减少频谱泄漏
        const windowed = this.buffer.map((v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))));
        const mags = new Float32Array(FFT_SIZE / 2);
        
        // 离散傅里叶变换 (DFT)
        for (let k = 0; k < FFT_SIZE / 2; k++) {
             let real = 0; let imag = 0;
             for (let n = 0; n < FFT_SIZE; n++) {
                 const theta = -2 * Math.PI * k * n / FFT_SIZE;
                 real += windowed[n] * Math.cos(theta);
                 imag += windowed[n] * Math.sin(theta);
             }
             // 归一化幅度: 乘以2除以N，得到真实的微伏(uV)值
             mags[k] = (2 * Math.sqrt(real * real + imag * imag)) / FFT_SIZE;
        }
        
        const res = SAMPLE_RATE / FFT_SIZE; // 频率分辨率 ~0.97 Hz
        
        // 计算特定频段的平均功率
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

  // 数据录制功能
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
  // 录制 API
  // --------------------------------------------------------------------------
  public startRecording() {
      this.isRecording = true;
      this.recordedData = [];
      this.log(">>> 开始录制原始数据...");
  }

  public stopRecording(): string {
      this.isRecording = false;
      this.log(`>>> 录制结束。共采集 ${this.recordedData.length} 个点。`);
      const json = JSON.stringify(this.recordedData);
      console.log("Recorded Data:", json);
      return json;
  }

  public getIsRecording() { return this.isRecording; }

  // --------------------------------------------------------------------------
  // 连接逻辑
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

      // 1. 发送握手
      await this.performHandshake();

      // 2. 自动发送开始指令 (许多芯片需要此指令开始推流)
      this.log(">>> 自动发送启动指令 (0x02)...");
      await new Promise(resolve => setTimeout(resolve, 500));
      await this.sendRawByte(0x02);
      
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

      // 策略选择
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

      // 构建数据包: 0xAA [Func=B0] [Len=3] [ID...] [CRC] 0xBB
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
      this.log(`>>> 切换握手策略 #${this.retryMode} 并重试`);
      await this.performHandshake();
  }

  // 发送自定义 Hex 命令
  public async sendHexCommand(hex: string) {
      if (!this.rxChar) return;
      
      const cleanHex = hex.replace(/[^0-9A-Fa-f]/g, '');
      if (cleanHex.length % 2 !== 0) {
          this.log("错误: Hex 长度必须是偶数");
          return;
      }
      
      const bytes = new Uint8Array(cleanHex.length / 2);
      for (let i = 0; i < cleanHex.length; i += 2) {
          bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
      }
      
      this.log(`TX [手动] >>> ${Array.from(bytes).map(b=>b.toString(16).padStart(2,'0').toUpperCase()).join(' ')}`);
      try {
          await this.rxChar.writeValue(bytes);
      } catch(e) {
          this.log(`写入错误: ${e}`);
      }
  }

  public async sendRawByte(byte: number) {
      if (!this.rxChar) return;
      try {
          await this.rxChar.writeValue(new Uint8Array([byte]));
          this.log(`TX [指令] >>> ${byte.toString(16).padStart(2,'0').toUpperCase()}`);
      } catch(e) {
           this.log(`写入错误: ${e}`);
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
    this.log("蓝牙已断开");
  }

  private onDisconnected() {
    this.log("蓝牙连接丢失");
    this.isConnected = false;
  }

  // --------------------------------------------------------------------------
  // 数据解析 (核心逻辑)
  // --------------------------------------------------------------------------

  private handleBluetoothData(event: any) {
      const value = event.target.value as DataView;
      for (let i = 0; i < value.byteLength; i++) {
          this.rawBuffer.push(value.getUint8(i));
      }
      this.processRawBuffer();
  }

  private processRawBuffer() {
      // 循环处理缓冲区，直到数据不足以构成一个包
      while (this.rawBuffer.length > 0) {
          // 1. 寻找帧头 0xAA
          const startIdx = this.rawBuffer.indexOf(0xAA);
          if (startIdx === -1) {
              this.rawBuffer = []; // 没有帧头，丢弃所有数据
              return;
          }
          if (startIdx > 0) {
              this.rawBuffer.splice(0, startIdx); // 丢弃帧头前面的垃圾数据
          }

          // 2. 检查最小长度 (AA Func Len ... CRC BB) 至少 5 字节
          if (this.rawBuffer.length < 5) return; 

          const len = this.rawBuffer[3]; // 数据载荷长度
          const frameSize = 6 + len; // 总帧长 = Header(1) + Func(1) + Len(1) + Data(0) + Payload(len) + CRC(1) + Tail(1) -- wait, protocol check
          // 协议结构: AA [Func] [Register/Type] [Len] [Payload...] [CRC] BB ?
          // 根据之前日志 "RX FUNC=20 LEN=1", 结构似乎是:
          // Byte 0: AA
          // Byte 1: Func (e.g., B0, 20, F1)
          // Byte 2: sub-func? or just part of payload? 
          // 让我们看之前的发送: AA B0 B0 03 ...
          // Byte 0: AA
          // Byte 1: Func (B0)
          // Byte 2: SubFunc/Reg (B0) ? 
          // Byte 3: Len (03)
          
          // 修正协议解析逻辑：基于 TX 包结构 "AA B0 B0 03 ... CRC BB"
          // Byte 0: AA
          // Byte 1: Func
          // Byte 2: Sub/Reg
          // Byte 3: Len
          // ... Payload (Len bytes) ...
          // Byte X: CRC
          // Byte Y: BB
          // 总长度 = 4 (Header部分) + Len + 2 (CRC+Tail) = 6 + Len
          
          if (this.rawBuffer.length < frameSize) return; // 数据包不完整，等待下一包

          // 3. 检查帧尾 0xBB
          if (this.rawBuffer[frameSize - 1] !== 0xBB) {
              // 帧尾不对，可能是假头，丢弃当前 0xAA，继续寻找
              this.rawBuffer.shift(); 
              continue; 
          }

          // 4. CRC 校验 (关键修复: 防止读取垃圾数据)
          // 校验范围: 从 Func 到 Payload 结束 (不含 AA 和 BB)
          // 对应索引: 1 到 frameSize - 3
          const dataForCrc = this.rawBuffer.slice(1, frameSize - 2); 
          const receivedCrc = this.rawBuffer[frameSize - 2];
          const calculatedCrc = calculateCRC8(dataForCrc);

          if (receivedCrc !== calculatedCrc) {
               this.log(`CRC 校验失败! Recv:${receivedCrc.toString(16)} Calc:${calculatedCrc.toString(16)}`);
               this.rawBuffer.shift(); // 丢弃坏包
               continue;
          }

          // 5. 解析有效载荷
          const func = this.rawBuffer[1];
          const payload = this.rawBuffer.slice(4, 4 + len);
          
          if (func === 0xF0 || func === 0xF1) {
              // 脑电波形数据
              this.parseSamples(payload);
          } else if (func >= 0x20 && func <= 0x39) {
              // 寄存器数据 (Log it to know device state)
              // 不需要显示太多，避免刷屏
              // this.log(`RX 寄存器 [${func.toString(16)}]`);
          } else if (func === 0xEE) {
               // 心跳包
          } else {
              this.log(`RX 未知指令 FUNC=${func.toString(16)} LEN=${len}`);
          }

          // 移除已处理的数据包
          this.rawBuffer.splice(0, frameSize);
      }
  }

  private parseSamples(payload: number[]) {
      // 24位 EEG 数据解析 (Big Endian)
      for (let i = 0; i < payload.length; i += 3) {
          if (i + 2 >= payload.length) break;
          
          let val = (payload[i] << 16) | (payload[i+1] << 8) | payload[i+2];
          // 补码处理 (24-bit signed)
          if (val & 0x800000) val = val - 0x1000000;
          
          const uv = val * SCALE_FACTOR;
          this.processSignal(uv);
      }
  }

  private processSignal(uv: number) {
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
