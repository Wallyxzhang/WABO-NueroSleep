import React, { useEffect, useState, useRef, useCallback } from 'react';
import { WaboLogo } from './components/Logo';
import { WaveChart } from './components/WaveChart';
import { AlphaVisualizer } from './components/AlphaVisualizer';
import { MetricCard } from './components/MetricCard';
import { signalProcessor } from './services/signalProcessing';
import { AppState, EEGDataPoint, FrequencyBands, AnalysisMetrics, Language } from './types';
import { HISTORY_LENGTH, UPDATE_INTERVAL_MS, TRANSLATIONS } from './constants';
import { Play, Pause, Activity, Bluetooth, Languages, Smartphone, Terminal, X, RefreshCw, Disc, Copy, Send, Zap, Eye, AlertTriangle, Power } from 'lucide-react';

const App: React.FC = () => {
  const [language, setLanguage] = useState<Language>('zh'); 
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [isDeviceConnected, setIsDeviceConnected] = useState<boolean>(false);
  const [isSimulating, setIsSimulating] = useState<boolean>(false);
  
  const [waveData, setWaveData] = useState<EEGDataPoint[]>([]);
  const [bands, setBands] = useState<FrequencyBands>({ delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 });
  const [metrics, setMetrics] = useState<AnalysisMetrics>({ attention: 0, relaxation: 0, isMeditating: false });

  // 调试日志状态
  const [showDebug, setShowDebug] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);
  
  // 录制状态
  const [isRecording, setIsRecording] = useState(false);
  
  // 协议调试
  const [debugRaw, setDebugRaw] = useState(false);
  const [ignoreCRC, setIgnoreCRC] = useState(false);
  const [cmdInput, setCmdInput] = useState("60 00 00"); // Default to Auto Config payload

  const intervalRef = useRef<number | null>(null);
  const lastVoiceTime = useRef<number>(0);

  const t = TRANSLATIONS[language];

  // 初始化日志监听
  useEffect(() => {
      signalProcessor.setLogger((msg) => {
          setLogs(prev => {
              const newLogs = [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`];
              if (newLogs.length > 50) return newLogs.slice(newLogs.length - 50);
              return newLogs;
          });
      });
  }, []);

  // 自动滚动日志
  useEffect(() => {
      if (showDebug && logsEndRef.current) {
          logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
      }
  }, [logs, showDebug]);

  const speak = useCallback((text: string) => {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    let preferredVoice = null;
    
    if (language === 'zh') {
        preferredVoice = voices.find(v => v.lang.includes('zh') || v.lang.includes('CN'));
    } else {
        preferredVoice = voices.find(v => v.lang.includes('en') && v.name.includes('Google'));
    }
    
    if (preferredVoice) utterance.voice = preferredVoice;
    utterance.rate = 0.9;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  }, [language]);

  const processFrame = () => {
    const packet = signalProcessor.getDataSnapshot();
    const isConnected = signalProcessor.getIsConnected();
    const isSimMode = signalProcessor.isSimulationMode();
    
    setIsDeviceConnected(isConnected);
    setIsSimulating(isSimMode);
    setIsRecording(signalProcessor.getIsRecording());

    setWaveData(prev => {
      const newData = [...prev, packet.raw];
      if (newData.length > HISTORY_LENGTH) {
        return newData.slice(newData.length - HISTORY_LENGTH);
      }
      return newData;
    });

    setBands(packet.bands);
    setMetrics(packet.metrics);

    const now = Date.now();
    
    if (appState === AppState.RUNNING) {
        if (packet.metrics.isMeditating && (now - lastVoiceTime.current > 15000)) {
          speak(t.voice_feedback);
          lastVoiceTime.current = now;
        } 
        else if (!packet.metrics.isMeditating && packet.metrics.relaxation < 0.7 && (now - lastVoiceTime.current > 8000)) {
           speak(t.focus_breath);
           lastVoiceTime.current = now;
        }
    }
  };

  const handleConnect = async () => {
    if (isSimulating) {
        await handleSimulation();
    }

    if (!isDeviceConnected) {
        setLogs([]); // 清空日志
        setShowDebug(true); // 自动打开控制台
        try {
            const success = await signalProcessor.connect();
            if (success) {
                setIsDeviceConnected(true);
                handleStartMonitoring();
            } else {
                const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
                if (isIOS && !(navigator as any).bluetooth) {
                    alert("iOS 需使用 'Bluefy' 浏览器。");
                }
            }
        } catch (e) {
            console.error(e);
            alert(`连接错误: ${e instanceof Error ? e.message : String(e)}`);
        }
    } else {
        await signalProcessor.disconnect();
        setIsDeviceConnected(false);
        handleStopMonitoring();
    }
  };
  
  const handleSendHex = async () => {
      await signalProcessor.sendHexCommand(cmdInput);
  };
  
  const handleAutoConfig = async () => {
      await signalProcessor.performAutoConfig();
  };

  const handleStopDevice = async () => {
      await signalProcessor.sendStop();
  };

  const toggleRawDebug = () => {
      const newVal = !debugRaw;
      setDebugRaw(newVal);
      signalProcessor.setDebugRaw(newVal);
  };

  const toggleIgnoreCRC = () => {
      const newVal = !ignoreCRC;
      setIgnoreCRC(newVal);
      signalProcessor.setIgnoreCRC(newVal);
  };

  const toggleRecording = () => {
      if (isRecording) {
          const data = signalProcessor.stopRecording();
          navigator.clipboard.writeText(data).then(() => {
              alert("数据已复制到剪贴板！");
          }).catch(err => {
              alert("无法复制，请查看日志控制台 (Recorded Data)");
          });
          setIsRecording(false);
      } else {
          signalProcessor.startRecording();
          setIsRecording(true);
      }
  };

  const handleSimulation = async () => {
    if (!isSimulating) {
        const granted = await signalProcessor.requestMotionPermission();
        if (granted) {
            signalProcessor.startSimulation();
            setIsSimulating(true);
            setIsDeviceConnected(true);
            handleStartMonitoring();
        } else {
            alert("需要权限");
        }
    } else {
        signalProcessor.stopSimulation();
        setIsSimulating(false);
        setIsDeviceConnected(false);
        handleStopMonitoring();
    }
  };

  const handleStartMonitoring = () => {
      setAppState(AppState.RUNNING);
      if (!intervalRef.current) {
          intervalRef.current = window.setInterval(processFrame, UPDATE_INTERVAL_MS);
          setWaveData([]); 
      }
  };

  const handleStopMonitoring = () => {
      setAppState(AppState.IDLE);
      if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
      }
  };

  const toggleLanguage = () => {
      setLanguage(prev => prev === 'zh' ? 'en' : 'zh');
  };

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col font-sans selection:bg-sky-500/30 pb-20">
      {/* 头部 Header */}
      <header className="px-6 py-4 flex items-center justify-between bg-slate-900/80 backdrop-blur-md sticky top-0 z-50 border-b border-slate-800">
        <WaboLogo />
        <div className="flex items-center gap-4">
          <button onClick={toggleLanguage} className="p-2 text-slate-400 hover:text-white transition-colors">
             <Languages size={20} />
          </button>

          <div className="hidden md:flex items-center gap-2 px-3 py-1 bg-slate-800 rounded-lg border border-slate-700">
            <div className={`w-2 h-2 rounded-full ${isDeviceConnected ? 'bg-green-500 animate-pulse' : 'bg-slate-500'}`} />
            <span className="text-xs font-mono text-slate-400">
                {t.device_status}: {isDeviceConnected ? t.connected : t.disconnected}
            </span>
          </div>
          
          <button 
            onClick={handleSimulation}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-semibold transition-all shadow-lg text-sm ${
              isSimulating
              ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-amber-500/20'
              : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
            }`}
          >
            <Smartphone size={16} />
            <span className="hidden sm:inline">{t.simulate}</span>
          </button>

          {!isSimulating && (
              <button 
                onClick={handleConnect}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg font-semibold transition-all shadow-lg text-sm ${
                  isDeviceConnected
                  ? 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                }`}
              >
                <Bluetooth size={16} />
                <span className="hidden sm:inline">{isDeviceConnected ? t.disconnect_btn : t.connect_btn}</span>
                <span className="sm:hidden">{isDeviceConnected ? "断开" : "连接"}</span>
              </button>
          )}

          {isDeviceConnected && (
            <button 
                onClick={appState === AppState.RUNNING ? handleStopMonitoring : handleStartMonitoring}
                className={`flex items-center gap-2 px-5 py-2 rounded-lg font-semibold transition-all shadow-lg ${
                appState === AppState.RUNNING 
                ? 'bg-red-500/10 text-red-400 border border-red-500/50 hover:bg-red-500/20' 
                : 'bg-sky-600 hover:bg-sky-500 text-white shadow-sky-500/20'
                }`}
            >
                {appState === AppState.RUNNING ? <Pause size={18} /> : <Play size={18} />}
            </button>
          )}
        </div>
      </header>

      {/* 主要内容区域 */}
      <main className="flex-1 container mx-auto px-4 py-6 max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 flex flex-col gap-6">
          <div className="flex-1 bg-gradient-to-b from-slate-800/30 to-slate-900/30 border border-slate-700/50 rounded-2xl relative overflow-hidden flex flex-col items-center justify-center min-h-[400px]">
             <div className="absolute inset-0 opacity-10" 
                  style={{ backgroundImage: 'linear-gradient(#334155 1px, transparent 1px), linear-gradient(90deg, #334155 1px, transparent 1px)', backgroundSize: '40px 40px' }}>
             </div>
             {isSimulating && (
                 <div className="absolute top-4 left-4 flex flex-col gap-1">
                     <div className="px-2 py-1 bg-amber-500/20 text-amber-400 text-xs rounded border border-amber-500/40 font-mono inline-block">SIMULATION</div>
                 </div>
             )}
             <AlphaVisualizer 
                alphaPower={bands.alpha}
                relaxationScore={metrics.relaxation}
                isMeditating={metrics.isMeditating}
                textMap={t}
             />
          </div>
          <WaveChart data={waveData} title={t.realtime_eeg} />
        </div>

        <div className="lg:col-span-5 flex flex-col gap-4">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="text-sky-400" size={20} />
            <h3 className="text-lg font-semibold text-slate-200">{t.analysis_title}</h3>
          </div>
          <div className="grid grid-cols-1 gap-3">
             <MetricCard label={t.alpha_desc} freqRange="8 - 14 Hz" value={bands.alpha} max={100} color="#38bdf8" />
             <MetricCard label={t.theta_desc} freqRange="4 - 8 Hz" value={bands.theta} max={100} color="#a78bfa" />
             <MetricCard label={t.beta_desc} freqRange="12 - 28 Hz" value={bands.beta} max={100} color="#f472b6" />
             <div className="grid grid-cols-2 gap-3">
               <MetricCard label={t.delta_desc} freqRange="0.5 - 4 Hz" value={bands.delta} max={50} color="#94a3b8" />
               <MetricCard label={t.gamma_desc} freqRange="25 - 40 Hz" value={bands.gamma} max={50} color="#fbbf24" />
             </div>
          </div>
          <div className="mt-4 p-4 bg-slate-800/50 rounded-xl border border-slate-700">
             <div className="flex justify-between items-center mb-4">
               <span className="text-slate-400 text-sm">{t.relaxation_index}</span>
               <span className="text-2xl font-bold text-white">{metrics.relaxation.toFixed(2)}</span>
             </div>
             <div className="w-full bg-slate-900 h-2 rounded-full overflow-hidden">
               <div className={`h-full transition-all duration-500 ${metrics.isMeditating ? 'bg-green-500' : 'bg-blue-500'}`} style={{ width: `${Math.min(100, metrics.relaxation * 100)}%` }} />
             </div>
          </div>
        </div>
      </main>

      {/* 开发者调试台 - 浮动在底部 */}
      <div className={`fixed bottom-0 left-0 right-0 bg-black/95 text-green-400 font-mono text-xs transition-transform duration-300 z-[100] border-t border-slate-700 ${showDebug ? 'translate-y-0' : 'translate-y-full'}`}>
        <div className="flex flex-col border-b border-slate-700">
            {/* 上半部分：标题和状态栏 */}
            <div className="flex justify-between items-center px-4 py-2 bg-slate-800">
                <span className="flex items-center gap-2 font-bold text-sky-400"><Terminal size={14}/> 调试 v3.0</span>
                <div className="flex gap-2 items-center">
                    {/* 指令输入区域 */}
                    <div className="flex items-center bg-slate-900 rounded border border-slate-700 mr-2">
                        <input 
                        type="text" 
                        value={cmdInput} 
                        onChange={(e) => setCmdInput(e.target.value)}
                        className="bg-transparent text-white w-24 px-2 py-1 outline-none uppercase placeholder-slate-600"
                        placeholder="AA BB ..."
                        />
                        <button onClick={handleSendHex} className="p-1 hover:text-sky-400 border-l border-slate-700" title="发送原始HEX"><Send size={12}/></button>
                    </div>
                    
                    <button onClick={() => setShowDebug(false)} className="text-slate-400 hover:text-white ml-2"><X size={16}/></button>
                </div>
            </div>

            {/* 下半部分：高级工具栏 */}
            <div className="flex gap-2 px-4 py-1.5 bg-slate-800/50 overflow-x-auto">
                 {/* Auto Config 按钮 */}
                 <button 
                    onClick={handleAutoConfig}
                    className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-sky-600 hover:bg-sky-500 text-white border border-sky-500"
                    title="一键初始化 (0x60)"
                 >
                    <Zap size={12}/> Auto Start
                 </button>

                 {/* Stop 按钮 */}
                 <button 
                    onClick={handleStopDevice}
                    className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-red-600/30 hover:bg-red-600/50 text-red-300 border border-red-500"
                    title="停止采集 (STOP)"
                 >
                    <Power size={12}/> Stop
                 </button>

                 <div className="w-px h-4 bg-slate-700 mx-1"></div>

                 {/* 强制解析开关 */}
                 <button 
                    onClick={toggleIgnoreCRC}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs border ${ignoreCRC ? 'bg-amber-500/20 border-amber-500 text-amber-400' : 'bg-slate-700 border-slate-600 text-slate-400'}`}
                    title="忽略CRC错误"
                 >
                    <AlertTriangle size={12}/> CRC {ignoreCRC ? "NO" : "OK"}
                 </button>

                 {/* 原始数据嗅探 */}
                 <button 
                    onClick={toggleRawDebug}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs border ${debugRaw ? 'bg-sky-500/20 border-sky-500 text-sky-400' : 'bg-slate-700 border-slate-600 text-slate-400'}`}
                    title="显示原始 HEX 数据"
                 >
                    <Eye size={12}/> {debugRaw ? "Raw" : "Log"}
                 </button>

                 <div className="w-px h-4 bg-slate-700 mx-1"></div>

                 <button 
                    onClick={toggleRecording} 
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs text-white border ${isRecording ? 'bg-red-600 border-red-500 animate-pulse' : 'bg-slate-700 border-slate-600 hover:bg-slate-600'}`}
                 >
                    {isRecording ? <><Copy size={12}/> Stop</> : <><Disc size={12}/> Rec</>}
                 </button>
            </div>
        </div>

        <div className="h-40 overflow-y-auto p-4 space-y-1 font-mono text-[11px] leading-tight">
            {logs.length === 0 && <span className="text-slate-600">等待数据... 连接后会自动执行 AutoStart (0x60)。</span>}
            {logs.map((log, i) => (
                <div key={i} className="break-all border-b border-slate-800/30 pb-1">{log}</div>
            ))}
            <div ref={logsEndRef} />
        </div>
      </div>

      {/* 调试开关按钮 (如果不显示的话) */}
      {!showDebug && (
          <button 
            onClick={() => setShowDebug(true)}
            className="fixed bottom-4 right-4 p-2 bg-slate-800 rounded-full border border-slate-700 text-slate-500 hover:text-white hover:bg-slate-700 z-50 shadow-lg"
            title="打开调试控制台"
          >
            <Terminal size={20} />
          </button>
      )}
    </div>
  );
};

export default App;