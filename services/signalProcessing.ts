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

const VERSION = "v3.0 (SW3011 Protocol)";
const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // 写入特征 (Write)
const UART_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // 通知特征 (Notify)

// ADS1299/SW3011 转换系数
// Gain=24 (Default), Vref=4.5V? 假设 Vref=2.4V (内部默认) 或 4.0V
// 文档提到 CONFIG2 VREF默认0(2.4V)。
// Scale = Vref / (Gain * (2^23 - 1))
// 假设 Gain=24 (默认), Vref=2.4V
// Scale = 2.4 / (24 * 8388607) * 10^6 uV ≈ 0.0119 uV/count
// 如果 Vref=4.0V, Scale ≈ 0.0198 uV/count
// 暂时使用通用经验值，后续可调
const SCALE_FACTOR = 0.01192; // uV per unit
const SAMPLE_RATE = 250; 
const FFT_SIZE = 256; 

// 协议常量
const PROTOCOL_START = 0xAA;
const PROTOCOL_END = 0xBB;

// --------------------------------------------------------------------------
// 辅助函数
// --------------------------------------------------------------------------

export type LogCallback = (msg: string) => void;

/**
 * SW3011 CRC-8 计算
 * Poly: 0x07 (x^8 + x^2 + x + 1)
 * Init: 0x00
 */
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
    private prevInput: number = 0;
    private prevOutput: number = 0;

    process(sample: number): number {
        // 去直流漂移 (High-pass filter at ~0.5Hz)
        const output = sample - this.prevInput + 0.995 * this.prevOutput;
        this.prevInput = sample;
        this.prevOutput = output;
        
        // 简单的 50Hz/60Hz 陷波滤波器 (可选，这里暂时略过，依赖 FFT 去除)
        
        this.buffer.push(output);
        if (this.buffer.length > FFT_SIZE) {
            this.buffer.shift();
        }
        return output;
    }

    getFFT(): FrequencyBands {
        if (this.buffer.length < FFT_SIZE) return { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
        
        // 汉宁窗
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

  // 调试开关
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

  // --------------------------------------------------------------------------
  // 公共控制 API
  // --------------------------------------------------------------------------

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

  // --------------------------------------------------------------------------
  // 连接与指令发送
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
        filters: [{ namePrefix: 'SILI' }], // SW3011 前缀可能是 SILI? 
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

      // 等待一点时间稳定
      await new Promise(r => setTimeout(r, 500));

      // 自动初始化流程
      await this.performAutoConfig();
      
      return true;

    } catch (e: any) {
      this.log(`连接错误: ${e.message}`);
      this.disconnect();
      throw e;
    }
  }

  /**
   * 发送 SW3011 格式的数据帧
   * Frame: AA FUNC ADDR LEN DATA CRC BB
   */
  public async sendFrame(func: number, addr: number, data: number[] = []) {
      if (!this.rxChar) return;
      
      const len = data.length;
      // 这里的 addr 也可以是 sub-opcode
      const payloadForCrc = [func, addr, len, ...data];
      const crc = calculateCRC8(new Uint8Array(payloadForCrc));
      const packet = new Uint8Array([PROTOCOL_START, ...payloadForCrc, crc, PROTOCOL_END]);
      
      const hexStr = Array.from(packet).map(b => b.toString(16).padStart(2,'0').toUpperCase()).join(' ');
      this.log(`TX >>> ${hexStr}`);
      
      try {
          await this.rxChar.writeValue(packet);
      } catch(e) {
          this.log(`发送失败: ${e}`);
      }
  }

  public async performAutoConfig() {
      this.log(">>> 执行自动配置 (0x60)...");
      // AUTO_CONFIG_START: AA 60 00 00 D2 BB
      await this.sendFrame(0x60, 0x00, []);
  }

  public async sendStop() {
      this.log(">>> 发送停止指令...");
      // SDATAC: AA 11 00 00 11 BB
      await this.sendFrame(0x11, 0x00, []);
      await new Promise(r => setTimeout(r, 50));
      // STOP: AA 0A 00 00 0A BB
      await this.sendFrame(0x0A, 0x00, []);
  }
  
  public async sendReset() {
      this.log(">>> 发送复位指令...");
      // RESET: AA 06 00 00 06 BB
      await this.sendFrame(0x06, 0x00, []);
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
    this.log("蓝牙已断开");
  }

  private onDisconnected() {
    this.log("蓝牙连接丢失");
    this.isConnected = false;
  }

  // --------------------------------------------------------------------------
  // 数据解析核心
  // --------------------------------------------------------------------------

  private handleBluetoothData(event: any) {
      const value = event.target.value as DataView;
      const newBytes = new Uint8Array(value.buffer);
      
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
      // 帧头 AA, 最小长度 7字节 (AA F A L CRC BB + 至少0 payload? Protocol says len can be 0)
      // Header: AA [1] [2] [3] ...
      // Len index = 3
      // Payload size = buffer[3]
      // Total size = 1(AA) + 1(Func) + 1(Addr) + 1(Len) + Payload + 1(CRC) + 1(BB) = 6 + Payload
      
      if (this.rawBuffer.length > 4096) {
          this.log("Buffer overflow, reset");
          this.rawBuffer = [];
      }

      while (this.rawBuffer.length >= 7) {
          // 1. 寻找帧头
          if (this.rawBuffer[0] !== PROTOCOL_START) {
              this.rawBuffer.shift();
              continue;
          }

          const payloadLen = this.rawBuffer[3];
          const frameSize = 6 + payloadLen;

          if (this.rawBuffer.length < frameSize) {
              // 数据不够，等待下一包
              return; 
          }

          // 2. 检查帧尾
          if (this.rawBuffer[frameSize - 1] !== PROTOCOL_END) {
              // 帧尾不对，可能是假头
              this.rawBuffer.shift();
              continue;
          }

          // 3. CRC 校验
          // 校验范围：Func(idx 1) 到 Payload结束(idx frameSize-2)
          const dataForCrc = this.rawBuffer.slice(1, frameSize - 1); // 包含 FUNC, ADDR, LEN, DATA
          const receivedCrc = this.rawBuffer[frameSize - 2];
          // Protocol: CRC range includes FUNC, ADDR, LEN, DATA
          // dataForCrc 现在的 slice 是 1 到 frameSize - 1，这包含了 CRC 本身在最后一位吗？
          // frameSize-1 是 BB 的位置。 frameSize-2 是 CRC 的位置。
          // 应该计算除 CRC 外的部分。
          // Slice(start, end) end is exclusive.
          // data to calc: index 1 to index frameSize-3 (inclusive) -> slice(1, frameSize-2)
          
          const calcData = this.rawBuffer.slice(1, frameSize - 2);
          const calculatedCrc = calculateCRC8(calcData);

          if (receivedCrc !== calculatedCrc && !this.ignoreCRC) {
              this.log(`CRC 失败: Rx ${receivedCrc.toString(16)} != Calc ${calculatedCrc.toString(16)}`);
              // 丢弃头，继续找
              this.rawBuffer.shift();
              continue;
          }

          // 4. 解析有效帧
          const funcCode = this.rawBuffer[1];
          const payload = this.rawBuffer.slice(4, 4 + payloadLen);
          
          this.parsePacket(funcCode, payload);

          // 移除已处理的帧
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
          default:
              if (func >= 0x20 && func <= 0x3F) {
                  // Register Read Response
              }
              break;
      }
  }

  private parseADCData(payload: number[]) {
      // 4.3 ADC 数据帧解析
      // 如果长度=6，说明只有1个样本（Status 3bytes + Data 3bytes）
      // 如果长度>6，说明是压缩格式：
      //   Sample 1: Status (3 bytes) + Data (3 bytes)
      //   Sample N: Status (1 byte)  + Data (3 bytes)
      
      let offset = 0;
      let sampleCount = 0;

      while (offset < payload.length) {
          let val = 0;
          let isFirst = (offset === 0);
          
          // 检查剩余长度
          if (isFirst) {
              if (offset + 6 > payload.length) break;
              // Status = payload[0..2], Data = payload[3..5]
              // 暂时忽略 Status
              val = (payload[offset+3] << 16) | (payload[offset+4] << 8) | payload[offset+5];
              offset += 6;
          } else {
              if (offset + 4 > payload.length) break;
              // Status = payload[0], Data = payload[1..3]
              val = (payload[offset+1] << 16) | (payload[offset+2] << 8) | payload[offset+3];
              offset += 4;
          }

          // 24-bit 补码转换
          if (val & 0x800000) val = val | 0xFF000000; // Sign extension
          
          // 转换为 uV
          const uv = val * SCALE_FACTOR;
          this.processSignal(uv);
          sampleCount++;
      }
      // this.log(`解析到 ${sampleCount} 个样本`);
  }
  
  private parseStatusFrame(payload: number[]) {
      // F1 01 03 [SYS] [LEAD] [BATT]
      if (payload.length >= 3) {
          const batt = payload[2];
          const lead = payload[1];
          // 可以在这里更新 UI 状态
          if (Math.random() < 0.05) this.log(`电池: ${batt}%, 导联: ${lead.toString(2)}`);
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
