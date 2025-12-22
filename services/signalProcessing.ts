import { FrequencyBands, AnalysisMetrics, EEGDataPoint } from '../types';
import { MEDITATION_THRESHOLD } from '../constants';

// --------------------------------------------------------------------------
// Web Bluetooth Interface Definitions
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
// Configuration & Constants
// --------------------------------------------------------------------------

const VERSION = "v3.9 (Wide Range)";
const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; 
const UART_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; 

const SCALE_FACTOR = 0.01192; 
const SAMPLE_RATE = 250; 
const FFT_SIZE = 256; 
const FFT_UPDATE_INTERVAL = 25; // Calculate FFT every 25 samples (10Hz)

const PROTOCOL_START = 0xAA;
const PROTOCOL_END = 0xBB;

// --------------------------------------------------------------------------
// Helper Functions
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
    private prevInput: number | null = null;
    private prevOutput: number = 0;
    private lpfPrev: number = 0; // Low Pass Filter State
    
    // Filters
    private medianBuffer: number[] = [];
    private lastValidRaw: number | null = null;
    private slewViolationCounter: number = 0;

    // Artifact Shield (V3.9)
    // Lockout countdown in samples. If > 0, we consider the signal noisy.
    private artifactLockout: number = 0;
    private readonly ARTIFACT_DURATION = 125; // 0.5 seconds lockout on spike
    private readonly NOISE_THRESHOLD_UV = 1500; // V3.9: Increased from 200 to 1500 to allow noisy data flow

    // Time-Window Buffering (V3.7)
    // Stores relative power bands for smoothing
    private bandHistory: FrequencyBands[] = [];
    private readonly HISTORY_SIZE = 20; // 2 seconds history at 10Hz updates

    reset() {
        this.buffer = [];
        this.prevInput = null;
        this.prevOutput = 0;
        this.lpfPrev = 0;
        this.medianBuffer = [];
        this.lastValidRaw = null;
        this.slewViolationCounter = 0;
        this.bandHistory = [];
        this.artifactLockout = 0;
    }

    process(sample: number): { filtered: number, quality: number } {
        // 1. Slew Rate Limiter (Prevent Impossible Jumps)
        // Adjusted for V3.8: If we consistently violate slew rate, we might be settling DC offset.
        // Allow jump if it persists.
        let cleanSample = sample;
        if (this.lastValidRaw !== null) {
            const diff = Math.abs(sample - this.lastValidRaw);
            // 5000uV jump per sample (1/250s) is physically impossible for brain waves
            // But possible for DC settling.
            if (diff > 5000) { 
                this.slewViolationCounter++;
                if (this.slewViolationCounter < 10) {
                    cleanSample = this.lastValidRaw; // Clamp
                } else {
                    // We've been stuck for 10 samples, assume the jump is real (DC shift)
                    this.lastValidRaw = sample; 
                    this.slewViolationCounter = 0;
                }
            } else {
                this.lastValidRaw = sample;
                this.slewViolationCounter = 0;
            }
        } else {
            this.lastValidRaw = sample;
        }

        // 2. Median Filter (Remove impulsive noise)
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

        // 3. High-Pass Filter (Remove DC Offset)
        // 0.995 is roughly a 0.5Hz cutoff at 250Hz sampling
        if (this.prevInput === null) {
            this.prevInput = filteredSample;
            this.prevOutput = 0;
            this.lpfPrev = 0;
            return { filtered: 0, quality: 1 };
        }

        const hpOutput = filteredSample - this.prevInput + 0.995 * this.prevOutput;
        this.prevInput = filteredSample;
        this.prevOutput = hpOutput;

        // 4. Low-Pass Filter (V3.9 - New)
        // Smooth out high frequency jitter/EMG (>30Hz). 
        // Simple exponential smoothing factor 0.3 (~30-40Hz cutoff)
        const lpOutput = this.lpfPrev + 0.3 * (hpOutput - this.lpfPrev);
        this.lpfPrev = lpOutput;
        
        const finalOutput = lpOutput;
        
        // 5. Update FFT Buffer
        this.buffer.push(finalOutput);
        if (this.buffer.length > FFT_SIZE) {
            this.buffer.shift();
        }

        // 6. Artifact Detection (Noise Gate)
        // If amplitude is too high, it's likely EMG (muscle) or EOG (eye) artifact.
        if (Math.abs(finalOutput) > this.NOISE_THRESHOLD_UV) {
            this.artifactLockout = this.ARTIFACT_DURATION;
        }

        if (this.artifactLockout > 0) {
            this.artifactLockout--;
        }

        // Quality metric: 1.0 = Clean, 0.0 = Artifact
        const quality = this.artifactLockout > 0 ? 0.0 : 1.0;

        return { filtered: finalOutput, quality };
    }

    // Calculates Relative Power (%) smoothed over time
    getSmoothedBands(): FrequencyBands | null {
        if (this.buffer.length < FFT_SIZE) return null;
        
        // V3.9: We NO LONGER return null here on artifacts.
        // We allow the FFT to run so the UI updates, but the 'quality' metric
        // will inform the user if the data is suspect.
        // if (this.artifactLockout > 0) return null; 

        // Perform FFT
        const windowed = this.buffer.map((v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))));
        const mags = new Float32Array(FFT_SIZE / 2);
        
        for (let k = 0; k < FFT_SIZE / 2; k++) {
             let real = 0; let imag = 0;
             // Optimized slightly: Calculate sin/cos once if possible, but JS JIT is good.
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

        const absoluteBands = {
            delta: getPower(0.5, 4),
            theta: getPower(4, 8),
            alpha: getPower(8, 14),
            beta: getPower(14, 28),
            gamma: getPower(28, 40)
        };

        const totalPower = absoluteBands.delta + absoluteBands.theta + absoluteBands.alpha + absoluteBands.beta + absoluteBands.gamma + 0.0001;
        
        const relativeBands: FrequencyBands = {
            delta: (absoluteBands.delta / totalPower) * 100,
            theta: (absoluteBands.theta / totalPower) * 100,
            alpha: (absoluteBands.alpha / totalPower) * 100,
            beta:  (absoluteBands.beta  / totalPower) * 100,
            gamma: (absoluteBands.gamma / totalPower) * 100
        };

        // Push to history buffer for smoothing
        this.bandHistory.push(relativeBands);
        if (this.bandHistory.length > this.HISTORY_SIZE) {
            this.bandHistory.shift();
        }

        // Return the average of the history buffer
        return this.averageBands(this.bandHistory);
    }

    private averageBands(history: FrequencyBands[]): FrequencyBands {
        if (history.length === 0) return { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 };
        
        const sum = history.reduce((acc, curr) => ({
            delta: acc.delta + curr.delta,
            theta: acc.theta + curr.theta,
            alpha: acc.alpha + curr.alpha,
            beta:  acc.beta + curr.beta,
            gamma: acc.gamma + curr.gamma,
        }), { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 });

        const len = history.length;
        return {
            delta: sum.delta / len,
            theta: sum.theta / len,
            alpha: sum.alpha / len,
            beta:  sum.beta / len,
            gamma: sum.gamma / len,
        };
    }
}

// --------------------------------------------------------------------------
// Bluetooth Device Service
// --------------------------------------------------------------------------

export class DeviceService {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private rxChar: BluetoothRemoteGATTCharacteristic | null = null; 
  
  private isConnected: boolean = false;
  private logCallback: LogCallback | null = null;
  
  private rawBuffer: number[] = [];
  private dsp: SignalProcessor = new SignalProcessor();
  private sampleCounter: number = 0;

  private debugRawEnabled: boolean = false;
  private ignoreCRC: boolean = false;

  private latestData: { 
    raw: EEGDataPoint, 
    bands: FrequencyBands, 
    metrics: AnalysisMetrics 
  } = {
    raw: { timestamp: 0, value: 0 },
    bands: { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 },
    metrics: { attention: 0, relaxation: 0, isMeditating: false, signalQuality: 1.0 }
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
      this.dsp.reset(); 
      
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

      this.log("正在尝试自动配置...");
      await new Promise(r => setTimeout(r, 500));
      await this.performAutoConfig();
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

          if (this.rawBuffer.length < frameSize || this.rawBuffer[frameSize - 1] !== PROTOCOL_END) {
              if(this.rawBuffer.length >= frameSize && this.rawBuffer[frameSize - 1] !== PROTOCOL_END) {
                  // Frame misalignment correction: if end byte is not where expected, shift 1
                  this.rawBuffer.shift(); 
                  continue;
              }
              // Not enough data yet
              return; 
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
      // FIX V3.8: Correctly handle interleaved channel data
      // Payload structure: [Counter(1)] [Ch1(3)] [Ch2(3)] [Ch1(3)] [Ch2(3)] ...
      
      // Start at index 1 to skip Packet Counter (usually index 0)
      let offset = 1;
      
      let channelIndex = 0; // 0 = Ch1, 1 = Ch2

      while (offset + 3 <= payload.length) {
          // Read 3 bytes (24-bit) - Little Endian
          const val = (payload[offset+2] << 16) | (payload[offset+1] << 8) | payload[offset];
          
          let signedVal = val;
          if (signedVal & 0x800000) {
              signedVal = signedVal | 0xFF000000;
          }

          const uv = signedVal * SCALE_FACTOR;

          // Only process Channel 1 (indices 0, 2, 4...)
          // Interleaved data: Ch1, Ch2, Ch1, Ch2...
          if (channelIndex === 0) {
              this.processSignal(uv);
          }

          offset += 3;
          channelIndex = (channelIndex + 1) % 2; // Toggle channel
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

      // 1. Filter the signal (every sample)
      const { filtered, quality } = this.dsp.process(uv);
      this.sampleCounter++;
      
      // Update Raw View (always active)
      if (filtered !== 0) {
          this.latestData.raw = { timestamp: Date.now(), value: filtered };
          this.latestData.metrics.signalQuality = quality;
          
          // 2. Compute FFT and Metrics (Throttled to 10Hz)
          if (this.sampleCounter % FFT_UPDATE_INTERVAL === 0) {
              
              const smoothedBands = this.dsp.getSmoothedBands();
              
              if (smoothedBands) {
                  const bands = smoothedBands;
                  
                  // Relaxation formula
                  const relaxScore = (bands.alpha * 2.0 + bands.theta) / 100;
                  const clampedRelax = Math.min(1.0, Math.max(0, relaxScore));
                  
                  const attnScore = (bands.beta + bands.gamma) / 80;
                  const clampedAttn = Math.min(1.0, Math.max(0, attnScore));

                  this.latestData.bands = bands;
                  this.latestData.metrics = {
                      relaxation: clampedRelax,
                      attention: clampedAttn,
                      isMeditating: clampedRelax > 0.65,
                      signalQuality: quality
                  };
              }
          }
      }
  }

  // --------------------------------------------------------------------------
  // Simulation Mode
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
    
    // Simulate relative bands
    const alphaSim = rel * 40 + 10;
    const betaSim = (1-rel) * 30 + 10;
    const thetaSim = 15;
    const deltaSim = 10;
    const gammaSim = 5;
    
    this.latestData = {
        raw: { timestamp: Date.now(), value: Math.sin(Date.now()/50)*10 + (Math.random()-0.5)*5 },
        bands: { delta: deltaSim, theta: thetaSim, alpha: alphaSim, beta: betaSim, gamma: gammaSim },
        metrics: { relaxation: rel, attention: 1-rel, isMeditating: rel > 0.7, signalQuality: 1.0 }
    };
  }
}

export const signalProcessor = new DeviceService();
