
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { WaboLogo } from './components/Logo';
import { WaveChart } from './components/WaveChart';
import { AlphaVisualizer } from './components/AlphaVisualizer';
import { MetricCard } from './components/MetricCard';
import { SignalQualityIndicator } from './components/SignalQualityIndicator';
import { signalProcessor } from './services/signalProcessing';
import { AppState, EEGDataPoint, FrequencyBands, AnalysisMetrics, Language } from './types';
import { HISTORY_LENGTH, UPDATE_INTERVAL_MS, TRANSLATIONS } from './constants';
import { Play, Pause, Activity, Bluetooth, Languages, Smartphone, Terminal, X, Send, Zap, Power } from 'lucide-react';

const App: React.FC = () => {
  const [language, setLanguage] = useState<Language>('zh'); 
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [isDeviceConnected, setIsDeviceConnected] = useState<boolean>(false);
  const [waveData, setWaveData] = useState<EEGDataPoint[]>([]);
  const [bands, setBands] = useState<FrequencyBands>({ delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 });
  const [metrics, setMetrics] = useState<AnalysisMetrics>({ attention: 0, relaxation: 0, isMeditating: false, signalQuality: 1.0 });

  const [showDebug, setShowDebug] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const intervalRef = useRef<number | null>(null);
  const lastVoiceTime = useRef<number>(0);
  const meditationDuration = useRef<number>(0);

  const t = TRANSLATIONS[language];

  // 语音引擎初始化：寻找最丝滑的女声
  const speak = useCallback((text: string) => {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel(); // 停止当前播放

    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    
    // 优先选择高质量中文女声 (Microsoft Xiaoxiao, Google Online, etc.)
    let voice = voices.find(v => (v.name.includes('Xiaoxiao') || v.name.includes('Female')) && v.lang.includes('zh'));
    if (!voice) voice = voices.find(v => v.lang.includes('zh'));
    
    if (voice) utterance.voice = voice;
    utterance.rate = 0.85; // 稍微放慢语速，更宁静
    utterance.pitch = 1.05; // 微调音调，更柔和
    window.speechSynthesis.speak(utterance);
  }, []);

  useEffect(() => {
    signalProcessor.setLogger((msg) => {
      setLogs(prev => [...prev.slice(-49), `[${new Date().toLocaleTimeString()}] ${msg}`]);
    });
    // 确保语音资源加载
    window.speechSynthesis.getVoices();
  }, []);

  const processFrame = () => {
    const data = signalProcessor.getDataSnapshot();
    setIsDeviceConnected(signalProcessor.getIsConnected());
    setIsRecording(signalProcessor.getIsRecording());

    setWaveData(prev => [...prev.slice(-(HISTORY_LENGTH - 1)), data.raw]);
    setBands(data.bands);
    setMetrics(data.metrics);

    if (appState === AppState.RUNNING) {
      const now = Date.now();
      // 语音交互逻辑优化
      if (data.metrics.isMeditating) {
        meditationDuration.current += UPDATE_INTERVAL_MS;
        if (meditationDuration.current > 10000 && (now - lastVoiceTime.current > 20000)) {
           speak(t.voice_deep);
           lastVoiceTime.current = now;
        }
      } else {
        meditationDuration.current = 0;
        if (data.metrics.relaxation < 0.4 && (now - lastVoiceTime.current > 30000)) {
           speak(t.voice_distracted);
           lastVoiceTime.current = now;
        }
      }
    }
  };

  const handleConnect = async () => {
    if (!isDeviceConnected) {
      const success = await signalProcessor.connect();
      if (success) {
        speak(t.voice_welcome);
        setAppState(AppState.RUNNING);
        intervalRef.current = window.setInterval(processFrame, UPDATE_INTERVAL_MS);
      }
    } else {
      signalProcessor.disconnect();
      setAppState(AppState.IDLE);
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      const result = signalProcessor.stopRecording();
      navigator.clipboard.writeText(result);
      alert("录制已保存至剪贴板");
    } else {
      signalProcessor.startRecording();
    }
    setIsRecording(!isRecording);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-sky-500/30">
      <header className="px-6 py-4 flex items-center justify-between bg-slate-950/50 backdrop-blur-xl sticky top-0 z-50 border-b border-white/5">
        <WaboLogo />
        <div className="flex items-center gap-3">
          <SignalQualityIndicator quality={metrics.signalQuality} isConnected={isDeviceConnected} language={language} />
          <button 
            onClick={handleConnect}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-full font-bold transition-all ${
              isDeviceConnected ? 'bg-white/10 text-white border border-white/20' : 'bg-sky-500 hover:bg-sky-400 text-white shadow-lg shadow-sky-500/20'
            }`}
          >
            <Bluetooth size={18} />
            {isDeviceConnected ? t.disconnect_btn : t.connect_btn}
          </button>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-8 max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-8 space-y-8">
          <div className="aspect-square lg:aspect-video bg-white/[0.02] border border-white/10 rounded-3xl relative overflow-hidden">
             <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(56,189,248,0.05),transparent)] pointer-events-none" />
             <AlphaVisualizer alphaPower={bands.alpha} relaxationScore={metrics.relaxation} isMeditating={metrics.isMeditating} textMap={t} />
          </div>
          <WaveChart data={waveData} title={t.realtime_eeg} />
        </div>

        <div className="lg:col-span-4 space-y-6">
          <div className="flex items-center gap-2 px-2">
            <Activity className="text-sky-400" size={20} />
            <h3 className="text-lg font-bold tracking-tight">{t.analysis_title}</h3>
          </div>
          <div className="space-y-3">
             <MetricCard label={t.alpha_desc} freqRange="8-13Hz" value={bands.alpha} max={100} color="#38bdf8" />
             <MetricCard label={t.beta_desc} freqRange="13-30Hz" value={bands.beta} max={100} color="#f472b6" />
             <MetricCard label={t.theta_desc} freqRange="4-8Hz" value={bands.theta} max={100} color="#a78bfa" />
             <div className="p-5 bg-white/[0.03] rounded-2xl border border-white/10">
               <div className="flex justify-between items-end mb-4">
                 <span className="text-slate-400 text-sm font-medium">{t.relaxation_index}</span>
                 <span className="text-4xl font-black text-white">{(metrics.relaxation * 100).toFixed(0)}%</span>
               </div>
               <div className="w-full bg-white/5 h-3 rounded-full overflow-hidden">
                 <div className={`h-full transition-all duration-1000 ${metrics.isMeditating ? 'bg-emerald-400' : 'bg-sky-400'}`} 
                      style={{ width: `${metrics.relaxation * 100}%` }} />
               </div>
             </div>
          </div>
          
          <button onClick={toggleRecording} className={`w-full py-4 rounded-2xl font-bold flex items-center justify-center gap-2 border transition-all ${
            isRecording ? 'bg-red-500/20 border-red-500/50 text-red-400 animate-pulse' : 'bg-white/5 border-white/10 hover:bg-white/10 text-slate-300'
          }`}>
            <div className={`w-2 h-2 rounded-full ${isRecording ? 'bg-red-500' : 'bg-slate-500'}`} />
            {isRecording ? "正在记录数据..." : "开始离线数据采样"}
          </button>
        </div>
      </main>

      {/* 极简调试控制台 */}
      <button onClick={() => setShowDebug(!showDebug)} className="fixed bottom-6 right-6 p-4 bg-slate-900 rounded-full border border-white/10 text-slate-400 hover:text-white z-50">
        <Terminal size={24} />
      </button>

      {showDebug && (
        <div className="fixed bottom-24 right-6 w-80 h-96 bg-slate-900/95 backdrop-blur border border-white/10 rounded-2xl overflow-hidden flex flex-col z-50 shadow-2xl">
          <div className="p-3 bg-white/5 border-b border-white/10 flex justify-between items-center text-xs font-bold text-slate-400">
            <span>ZEN MASTER DEBUG v4.0</span>
            <X size={14} className="cursor-pointer" onClick={() => setShowDebug(false)} />
          </div>
          <div className="flex-1 overflow-y-auto p-3 font-mono text-[10px] space-y-1 text-sky-400/80">
            {logs.map((log, i) => <div key={i} className="border-b border-white/5 pb-1">{log}</div>)}
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
