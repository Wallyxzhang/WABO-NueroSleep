import { FrequencyBands, AnalysisMetrics, EEGDataPoint } from '../types';
import { MEDITATION_THRESHOLD, SAMPLING_RATE } from '../constants';

// Define Web Serial API types
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

// --- DSP & Protocol Helpers ---

/**
 * CRC-8 Maxim/Dallas Implementation
 * Polynomial: x^8 + x^5 + x^4 + 1 (0x31)
 * This algorithm typically processes LSB first.
 * Equivalent to Poly 0x8C when shifting right.
 */
function crc8(data: Uint8Array | number[]): number {
  let crc = 0x00;
  for (let i = 0; i < data.length; i++) {
    let byte = data[i];
    for (let j = 0; j < 8; j++) {
      const mix = (crc ^ byte) & 0x01;
      crc >>= 1;
      if (mix) {
        crc ^= 0x8C;
      }
      byte >>= 1;
    }
  }
  return crc;
}

// Simple FFT Implementation (Cooley-Tukey)
// Input: real array. Output: magnitude array of half size.
function calculateSpectrum(inputData: number[]): number[] {
    const N = inputData.length;
    const real = new Float32Array(inputData);
    const imag = new Float32Array(N).fill(0);

    // Bit reversal
    let j = 0;
    for (let i = 0; i < N - 1; i++) {
        if (i < j) {
            [real[i], real[j]] = [real[j], real[i]];
            [imag[i], imag[j]] = [imag[j], imag[i]];
        }
        let k = N / 2;
        while (k <= j) {
            j -= k;
            k /= 2;
        }
        j += k;
    }

    // Butterfly operations
    for (let len = 2; len <= N; len <<= 1) {
        const angle = -2 * Math.PI / len;
        const wlen_r = Math.cos(angle);
        const wlen_i = Math.sin(angle);
        for (let i = 0; i < N; i += len) {
            let w_r = 1;
            let w_i = 0;
            for (let j = 0; j < len / 2; j++) {
                const u_r = real[i + j];
                const u_i = imag[i + j];
                const v_r = real[i + j + len / 2] * w_r - imag[i + j + len / 2] * w_i;
                const v_i = real[i + j + len / 2] * w_i + imag[i + j + len / 2] * w_r;
                real[i + j] = u_r + v_r;
                imag[i + j] = u_i + v_i;
                real[i + j + len / 2] = u_r - v_r;
                imag[i + j + len / 2] = u_i - v_i;
                
                const temp_w_r = w_r * wlen_r - w_i * wlen_i;
                w_i = w_r * wlen_i + w_i * wlen_r;
                w_r = temp_w_r;
            }
        }
    }

    // Compute magnitude
    const magnitudes = [];
    for (let i = 0; i < N / 2; i++) {
        magnitudes.push(Math.sqrt(real[i] * real[i] + imag[i] * imag[i]));
    }
    return magnitudes;
}

export class DeviceService {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private isConnected: boolean = false;
  
  // Protocol Buffers
  private binaryBuffer: Uint8Array = new Uint8Array(0);
  private rawSignalBuffer: number[] = []; // Stores uV values for FFT
  
  // Simulation State
  private isSimulating: boolean = false;
  private agitationLevel: number = 0;
  private lastAcceleration: { x: number, y: number, z: number } | null = null;
  private simulationInterval: number | null = null;
  
  // Data State
  private latestData: { 
    raw: EEGDataPoint, 
    bands: FrequencyBands, 
    metrics: AnalysisMetrics 
  } = {
    raw: { timestamp: 0, value: 0 },
    bands: { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 },
    metrics: { attention: 0, relaxation: 0, isMeditating: false }
  };

  // Constants for Protocol & Analysis
  private readonly FFT_SIZE = 256; 
  // Scale Calculation based on sw3011.c:
  // Vref = 2.4V (CONFIG2_VREF_2V4)
  // Gain = 6 (CH2SET_GAIN2_6)
  // Range = +/- (Vref / Gain) = +/- 0.4V
  // LSB = (Vref / Gain) / (2^23 - 1)
  // uV = ADC * (2400000 / 6 / 8388607)
  private readonly UV_SCALE = (2.4 / 6 / 8388607) * 1000000;

  constructor() {}

  public getIsConnected(): boolean {
    return this.isConnected || this.isSimulating;
  }

  public isSimulationMode(): boolean {
    return this.isSimulating;
  }

  // --- Simulation Logic ---
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
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('devicemotion', this.handleMotion);
    }
    if (this.simulationInterval) clearInterval(this.simulationInterval);
    this.simulationInterval = window.setInterval(() => this.updateSimulation(), 100);
  }

  public stopSimulation() {
    this.isSimulating = false;
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('devicemotion', this.handleMotion);
    }
    if (this.simulationInterval) {
      clearInterval(this.simulationInterval);
      this.simulationInterval = null;
    }
    this.lastAcceleration = null;
    this.agitationLevel = 0;
    this.resetData();
  }

  private handleMotion = (event: DeviceMotionEvent) => {
    let x = event.acceleration?.x;
    let y = event.acceleration?.y;
    let z = event.acceleration?.z;
    if (x === null || y === null || z === null) {
       x = event.accelerationIncludingGravity?.x ?? 0;
       y = event.accelerationIncludingGravity?.y ?? 0;
       z = event.accelerationIncludingGravity?.z ?? 0;
    }
    if (x === null || y === null || z === null) return;
    if (this.lastAcceleration) {
      const delta = Math.abs(x - this.lastAcceleration.x) + 
                    Math.abs(y - this.lastAcceleration.y) + 
                    Math.abs(z - this.lastAcceleration.z);
      if (delta > 1.0) {
         this.agitationLevel += delta * 1.5; 
      }
    }
    this.lastAcceleration = { x, y, z };
  }

  private updateSimulation() {
    this.agitationLevel = Math.max(0, this.agitationLevel * 0.96);
    const normalizedAgitation = Math.min(this.agitationLevel / 20, 1);
    const targetRelaxation = 1 - normalizedAgitation;
    const prevRelaxation = this.latestData.metrics.relaxation || 0.5;
    const relaxation = prevRelaxation * 0.85 + targetRelaxation * 0.15;
    const attention = 1 - relaxation;
    const isMeditating = relaxation > MEDITATION_THRESHOLD;
    const random = () => Math.random();
    
    // Simulate spectral power based on relaxation state
    const alpha = (relaxation * 40) + 10 + (random() * 5); 
    const beta = (attention * 30) + 5 + (random() * 5);
    const theta = 10 + random() * 5;
    const delta = 5 + random() * 5;
    const gamma = (attention * 20) + random() * 5;
    
    // Generate realistic looking raw wave
    const t = Date.now() / 1000;
    let rawValue = 0;
    if (relaxation > 0.7) {
        // Alpha dominance (8-12Hz)
        rawValue = Math.sin(t * 10 * Math.PI * 2) * 50 + (random() * 8);
    } else {
        // Beta dominance (faster, irregular)
        rawValue = Math.sin(t * 22 * Math.PI * 2) * 20 + (random() * 40 - 20) + (Math.sin(t * 4) * 10);
    }

    this.latestData = {
        raw: { timestamp: Date.now(), value: rawValue },
        bands: { delta, theta, alpha, beta, gamma },
        metrics: { attention, relaxation, isMeditating }
    };
  }

  // --- Real Device Connection (SW3011 Protocol) ---

  public async connect(deviceId: string = "000000"): Promise<boolean> {
    if (this.isSimulating) this.stopSimulation();

    try {
      if (!navigator.serial) {
        console.error("Web Serial API not supported.");
        return false;
      }

      this.port = await navigator.serial.requestPort();
      // SW3011 typically uses 115200 or similar high speed
      await this.port.open({ baudRate: 115200, bufferSize: 4096 });
      
      this.isConnected = true;
      
      // Send Handshake immediately
      await this.sendHandshake(deviceId);
      
      // Start Reading Loop
      this.readLoop();
      
      return true;
    } catch (error) {
      console.error("Device connection failed:", error);
      return false;
    }
  }

  private async sendHandshake(deviceIdStr: string) {
    if (!this.port || !this.port.writable) return;

    // Protocol: AA B0 B0 03 ID1 ID2 ID3 CRC BB
    // ID is 3 bytes BCD. E.g. "123456" -> 0x12 0x34 0x56
    
    // 1. Sanitize and pad ID
    const cleanId = deviceIdStr.replace(/[^0-9]/g, '').padEnd(6, '0').slice(0, 6);
    
    // 2. Convert to BCD bytes
    const id1 = parseInt(cleanId.substring(0, 2), 16);
    const id2 = parseInt(cleanId.substring(2, 4), 16);
    const id3 = parseInt(cleanId.substring(4, 6), 16);

    const payload = [0xB0, 0xB0, 0x03, id1, id2, id3];
    
    // 3. Calculate CRC (Maxim 0x31) on the payload fields
    // Protocol doc implies checking CRC of the fields between Start and CRC.
    const crc = crc8(payload);
    
    // 4. Construct Frame
    const frame = new Uint8Array([0xAA, ...payload, crc, 0xBB]);
    
    const writer = this.port.writable.getWriter();
    await writer.write(frame);
    writer.releaseLock();
    console.log("Sent Handshake:", frame);
  }

  public async disconnect() {
    if (this.isSimulating) {
        this.stopSimulation();
        return;
    }
    if (this.reader) await this.reader.cancel();
    if (this.port) await this.port.close();
    this.isConnected = false;
    this.port = null;
    this.reader = null;
    this.resetData();
  }

  private resetData() {
    this.latestData = {
        raw: { timestamp: 0, value: 0 },
        bands: { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 },
        metrics: { attention: 0, relaxation: 0, isMeditating: false }
    };
    this.rawSignalBuffer = [];
    this.binaryBuffer = new Uint8Array(0);
  }

  private async readLoop() {
    if (!this.port || !this.port.readable) return;

    this.reader = this.port.readable.getReader();

    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
            this.appendBuffer(value);
            this.processBinaryFrames();
        }
      }
    } catch (error) {
      console.error("Read Loop Error:", error);
    } finally {
      this.reader.releaseLock();
      this.isConnected = false;
    }
  }

  private appendBuffer(newData: Uint8Array) {
      const newBuffer = new Uint8Array(this.binaryBuffer.length + newData.length);
      newBuffer.set(this.binaryBuffer);
      newBuffer.set(newData, this.binaryBuffer.length);
      this.binaryBuffer = newBuffer;
  }

  /**
   * Processes buffer for frames: AA F0 ADDR LEN [DATA...] CRC BB
   */
  private processBinaryFrames() {
    let buffer = this.binaryBuffer;
    
    // Process as many frames as possible
    while (buffer.length >= 6) { // Min valid frame size is header(4)+CRC(1)+End(1) = 6
        // 1. Search for START byte 0xAA
        const startIndex = buffer.indexOf(0xAA);
        
        if (startIndex === -1) {
            // Discard junk
            buffer = new Uint8Array(0);
            break;
        }
        
        // If 0xAA is not at the start, discard bytes before it
        if (startIndex > 0) {
            buffer = buffer.slice(startIndex);
            continue;
        }

        // 2. Check Header
        // Byte 0: AA
        // Byte 1: FUNC (Should be F0 for data)
        // Byte 2: ADDR
        // Byte 3: LEN (Payload Length)
        
        // Wait for header bytes
        if (buffer.length < 4) break;

        const func = buffer[1];
        const addr = buffer[2];
        const len = buffer[3];
        
        // Calculate expected packet size
        const packetSize = 4 + len + 2; // Header(4) + Payload(len) + CRC(1) + End(1)

        // Wait for full packet
        if (buffer.length < packetSize) {
            break;
        }

        // 3. Validate End Byte
        if (buffer[packetSize - 1] !== 0xBB) {
            // Invalid packet framing, shift by 1 and retry
            buffer = buffer.slice(1);
            continue;
        }

        // 4. Validate CRC
        // CRC includes FUNC, ADDR, LEN, PAYLOAD...
        const crcSource = buffer.slice(1, packetSize - 2);
        const receivedCrc = buffer[packetSize - 2];
        const calculatedCrc = crc8(crcSource);

        if (receivedCrc === calculatedCrc) {
            // Valid Frame Found
            if (func === 0xF0) {
                const payload = buffer.slice(4, 4 + len);
                this.parseEEGPayload(payload);
            }
            // Move past this packet
            buffer = buffer.slice(packetSize);
        } else {
            console.warn(`CRC Mismatch: Recv ${receivedCrc.toString(16)} vs Calc ${calculatedCrc.toString(16)}`);
            // Discard start byte and retry
            buffer = buffer.slice(1);
        }
    }
    
    this.binaryBuffer = buffer;
  }

  private parseEEGPayload(payload: Uint8Array) {
    // Payload contains 24-bit samples (3 bytes each)
    for (let i = 0; i < payload.length; i += 3) {
        if (i + 2 >= payload.length) break;

        const b0 = payload[i];     // MSB
        const b1 = payload[i+1];
        const b2 = payload[i+2];   // LSB

        // Combine to 24-bit signed int
        let rawInt = (b0 << 16) | (b1 << 8) | b2;
        
        // Sign extension for 24-bit
        if (rawInt & 0x800000) {
            rawInt -= 0x1000000;
        }

        // Convert to uV
        const uvValue = rawInt * this.UV_SCALE;

        // Push to buffers
        this.latestData.raw = { timestamp: Date.now(), value: uvValue };
        this.rawSignalBuffer.push(uvValue);
    }

    // Trigger analysis window
    // We maintain a sliding window of FFT_SIZE for smooth updates
    if (this.rawSignalBuffer.length >= this.FFT_SIZE) {
        const windowData = this.rawSignalBuffer.slice(this.rawSignalBuffer.length - this.FFT_SIZE);
        this.analyzeSignal(windowData);
        
        // Cap buffer size to prevent memory leaks, keeping enough for overlap
        if (this.rawSignalBuffer.length > 1000) {
            this.rawSignalBuffer = this.rawSignalBuffer.slice(this.rawSignalBuffer.length - 500);
        }
    }
  }

  private analyzeSignal(data: number[]) {
    // 1. Detrend (Remove DC)
    const mean = data.reduce((a, b) => a + b, 0) / data.length;
    const centered = data.map(v => v - mean);

    // 2. Window Function (Hanning)
    const windowed = centered.map((v, i) => v * (0.5 * (1 - Math.cos(2 * Math.PI * i / (data.length - 1)))));

    // 3. FFT
    const spectrum = calculateSpectrum(windowed);

    // 4. Band Powers
    const res = SAMPLING_RATE / this.FFT_SIZE; // ~0.97Hz per bin

    const getPower = (minHz: number, maxHz: number) => {
        const minBin = Math.floor(minHz / res);
        const maxBin = Math.ceil(maxHz / res);
        let sum = 0;
        let count = 0;
        for (let i = minBin; i <= maxBin && i < spectrum.length; i++) {
            sum += spectrum[i];
            count++;
        }
        return count > 0 ? sum / count : 0;
    };

    const delta = getPower(0.5, 4);
    const theta = getPower(4, 8);
    const alpha = getPower(8, 14);
    const beta = getPower(14, 30);
    const gamma = getPower(30, 40);

    // 5. Calculate Metrics
    // Relaxation: Dominant Alpha relative to Theta/Beta
    // Simple ratio used in meditation gadgets: Alpha / (Beta + Theta)
    const eps = 0.001;
    const totalPower = delta + theta + alpha + beta + gamma + eps;
    
    // Algorithm adjustment for SW3011 sensitivity
    // Normalizing the result to 0.0 - 1.0 range
    // A raw ratio > 0.5 is usually good relaxation
    const rawRelaxationRatio = alpha / (beta + theta + eps);
    const relaxation = Math.min(1, Math.max(0, rawRelaxationRatio * 0.8)); // scaling factor
    
    const rawAttentionRatio = beta / (alpha + theta + eps);
    const attention = Math.min(1, Math.max(0, rawAttentionRatio * 0.8));

    const isMeditating = relaxation > MEDITATION_THRESHOLD;

    this.latestData.bands = { delta, theta, alpha, beta, gamma };
    this.latestData.metrics = { 
        attention, 
        relaxation, 
        isMeditating 
    };
  }

  public getDataSnapshot() {
    return this.latestData;
  }
}

export const signalProcessor = new DeviceService();
