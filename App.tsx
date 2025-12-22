
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { WaboLogo } from './components/Logo';
import { WaveChart } from './components/WaveChart';
import { AlphaVisualizer } from './components/AlphaVisualizer';
import { MetricCard } from './components/MetricCard';
import { SignalQualityIndicator } from './components/SignalQualityIndicator';
import { signalProcessor } from './services/signalProcessing';
import { AppState, EEGDataPoint, FrequencyBands, AnalysisMetrics, Language } from './types';
import { HISTORY_LENGTH, UPDATE_INTERVAL_MS, TRANSLATIONS, MEDITATION_THRESHOLD } from './constants';
import { Play, Pause, Activity, Bluetooth, Languages, Smartphone, Terminal, X, Power, Zap } from 'lucide-react';

const App: React.FC = () => {
  const [language, setLanguage] = useState<Language>('zh'); 
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [isDeviceConnected, setIsDeviceConnected] = useState<boolean>(false);
  const [isSimulating, setIsSimulating] = useState<boolean>(false);
  
  const [waveData, setWaveData] = useState<EEGDataPoint[]>([]);
  const [bands, setBands] = useState<FrequencyBands>({ delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 });
  const [metrics, setMetrics] = useState<AnalysisMetrics>({ attention: 0, relaxation: 0, isMeditating: false, signalQuality: 1.0 });

  const [showDebug, setShowDebug] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  
  const intervalRef = useRef<number | null>(null);
  const lastVoiceTime = useRef<number>(0);
  const meditationDuration = useRef<number>(0);

  const t = TRANSLATIONS[language];

  // 语音引擎封装：增加初始化解锁
  const speak = useCallback((text: string) => {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel(); // 停止当前所有播放
    
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    // 寻找最适合的中文或英文语音
    const preferredVoice = voices.find(v => v.lang.includes(language === 'zh' ? 'zh' : 'en'));
    if (preferredVoice) utterance.voice = preferredVoice;
    
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    window.speechSynthesis.speak(utterance);
  }, [language]);

  // 解锁语音引擎（浏览器安全限制）
  const unlockAudio = () => {
      speak(" "); // 播放一段空白，激活音频上下文
  };

  const processFrame = () => {
    const packet = signalProcessor.getDataSnapshot();
    setIsDeviceConnected(signalProcessor.getIsConnected());

    setWaveData(prev => {
      const newData = [...prev, packet.raw];
      return newData.length > HISTORY_LENGTH ? newData.slice(1) : newData;
    });

    setBands(packet.bands);
    setMetrics(packet.metrics);

    if (appState === AppState.RUNNING) {
        const now = Date.now();
        // 逻辑：如果处于冥想状态，且距离上次说话超过 20 秒，则播报鼓励
        if (packet.metrics.isMeditating) {
            meditationDuration.current += UPDATE_INTERVAL_MS;
            if (now - lastVoiceTime.current > 20000) {
                speak(t.voice_feedback_good);
                lastVoiceTime.current = now;
            }
        } else {
            // 如果放松度低于阈值，且 15 秒没提醒，则轻微引导
            if (packet.metrics.relaxation < (MEDITATION_THRESHOLD - 0.1) && (now - lastVoiceTime.current > 15000)) {
                speak(t.voice_distracted);
                lastVoiceTime.current = now;
            }
        }
    }
  };

  const handleConnect = async () => {
    if (!isDeviceConnected) {
        unlockAudio(); // 用户点击按钮时顺便解锁语音
        const success = await signalProcessor.connect();
        if (success) {
            setIsDeviceConnected(true);
            setLogs(p => [...p, "设备已连接，准备开始..."]);
        }
    } else {
        signalProcessor.disconnect();
        setIsDeviceConnected(false);
        handleStopMonitoring();
    }
  };

  const handleStartMonitoring = () => {
      unlockAudio();
      setAppState(AppState.RUNNING);
      meditationDuration.current = 0;
      lastVoiceTime.current = Date.now();
      speak(t.voice_welcome); // 初始引导语
      
      if (!intervalRef.current) {
          intervalRef.current = window.setInterval(processFrame, UPDATE_INTERVAL_MS);
      }
  };

  const handleStopMonitoring = () => {
      setAppState(AppState.IDLE);
      if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
      }
  };

  useEffect(() => {
      signalProcessor.setLogger(m => setLogs(prev => [m, ...prev].slice(0, 20)));
      return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col font-sans selection:bg-sky-500/30">
      <header className="px-6 py-4 flex items-center justify-between bg-slate-900/80 backdrop-blur-md sticky top-0 z-50 border-b border-slate-800">
        <WaboLogo />
        <div className="flex items-center gap-3">
          <button onClick={() => setLanguage(l => l==='zh'?'en':'zh')} className="p-2 text-slate-400 hover:text-white"><Languages size={20} /></button>
          
          <button 
            onClick={handleConnect}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl font-bold transition-all shadow-lg ${
              isDeviceConnected ? 'bg-slate-700 text-slate-300' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
            }`}
          >
            <Bluetooth size={18} />
            <span>{isDeviceConnected ? t.disconnect_btn : t.connect_btn}</span>
          </button>

          {isDeviceConnected && (
            <button 
                onClick={appState === AppState.RUNNING ? handleStopMonitoring : handleStartMonitoring}
                className={`flex items-center gap-2 px-6 py-2 rounded-xl font-bold transition-all shadow-lg ${
                    appState === AppState.RUNNING ? 'bg-red-500/20 text-red-400 border border-red-500/50' : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                }`}
            >
                {appState === AppState.RUNNING ? <Pause size={20} /> : <Play size={20} />}
                <span>{appState === AppState.RUNNING ? t.stop_btn : t.start_btn}</span>
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-8 max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-7 flex flex-col gap-6">
          <div className="flex-1 bg-slate-800/20 border border-slate-700/50 rounded-3xl relative overflow-hidden flex flex-col items-center justify-center min-h-[450px] shadow-2xl">
             <div className="absolute top-4 left-4 z-20">
                 <SignalQualityIndicator quality={metrics.signalQuality} isConnected={isDeviceConnected} language={language} />
             </div>
             <AlphaVisualizer alphaPower={bands.alpha} relaxationScore={metrics.relaxation} isMeditating={metrics.isMeditating} textMap={t} />
          </div>
          <WaveChart data={waveData} title={t.realtime_eeg} />
        </div>

        <div className="lg:col-span-5 flex flex-col gap-6">
          <div className="bg-slate-800/40 p-6 rounded-3xl border border-slate-700/50">
              <div className="flex items-center gap-2 mb-6">
                <Activity className="text-sky-400" size={24} />
                <h3 className="text-xl font-bold">{t.analysis_title}</h3>
              </div>
              
              <div className="space-y-4">
                 <MetricCard label={t.alpha_desc} freqRange="8-13Hz" value={bands.alpha} max={100} color="#38bdf8" />
                 <MetricCard label={t.beta_desc} freqRange="14-30Hz" value={bands.beta} max={100} color="#f472b6" />
                 <div className="grid grid-cols-2 gap-4">
                    <MetricCard label="Theta" freqRange="4-8Hz" value={bands.theta} max={100} color="#a78bfa" />
                    <MetricCard label="Gamma" freqRange="30-45Hz" value={bands.gamma} max={100} color="#fbbf24" />
                 </div>
              </div>

              <div className="mt-8 p-6 bg-slate-900/60 rounded-2xl border border-slate-700">
                 <div className="flex justify-between items-end mb-4">
                   <span className="text-slate-400 font-medium">{t.relaxation_index}</span>
                   <span className="text-4xl font-black text-sky-400">{(metrics.relaxation * 100).toFixed(0)}%</span>
                 </div>
                 <div className="w-full bg-slate-800 h-3 rounded-full overflow-hidden">
                   <div className={`h-full transition-all duration-1000 ${metrics.isMeditating ? 'bg-emerald-500 shadow-[0_0_15px_#10b981]' : 'bg-sky-500'}`} style={{ width: `${metrics.relaxation * 100}%` }} />
                 </div>
              </div>
          </div>

          <div className="bg-slate-800/20 p-4 rounded-2xl border border-slate-700/50 flex-1 overflow-y-auto max-h-[200px] font-mono text-xs">
              <div className="flex items-center gap-2 text-slate-500 mb-2 border-b border-slate-700 pb-1">
                  <Terminal size={14} /> <span>LOGS</span>
              </div>
              {logs.map((log, i) => <div key={i} className="text-slate-400 mb-1">{log}</div>)}
          </div>
        </div>
      </main>

      {/* 快捷启动悬浮窗 */}
      <button 
        onClick={() => signalProcessor.startSimulation()}
        className="fixed bottom-6 right-6 p-4 bg-amber-600 rounded-full shadow-2xl hover:bg-amber-500 transition-transform active:scale-95"
      >
        <Smartphone size={24} />
      </button>
    </div>
  );
};

export default App;
