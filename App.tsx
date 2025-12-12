import React, { useEffect, useState, useRef, useCallback } from 'react';
import { WaboLogo } from './components/Logo';
import { WaveChart } from './components/WaveChart';
import { AlphaVisualizer } from './components/AlphaVisualizer';
import { MetricCard } from './components/MetricCard';
import { signalProcessor } from './services/signalProcessing';
import { AppState, EEGDataPoint, FrequencyBands, AnalysisMetrics, Language } from './types';
import { HISTORY_LENGTH, UPDATE_INTERVAL_MS, TRANSLATIONS } from './constants';
import { Play, Pause, Activity, Bluetooth, Languages, Smartphone, Hash } from 'lucide-react';

const App: React.FC = () => {
  const [language, setLanguage] = useState<Language>('zh'); // 默认中文
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [isDeviceConnected, setIsDeviceConnected] = useState<boolean>(false);
  const [isSimulating, setIsSimulating] = useState<boolean>(false);
  const [deviceId, setDeviceId] = useState<string>("123456"); // Device ID for protocol
  
  const [waveData, setWaveData] = useState<EEGDataPoint[]>([]);
  const [bands, setBands] = useState<FrequencyBands>({ delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 });
  const [metrics, setMetrics] = useState<AnalysisMetrics>({ attention: 0, relaxation: 0, isMeditating: false });

  const intervalRef = useRef<number | null>(null);
  const lastVoiceTime = useRef<number>(0);

  // 获取当前语言的文本包
  const t = TRANSLATIONS[language];

  const speak = useCallback((text: string) => {
    if (!window.speechSynthesis) return;
    // 取消当前的语音，避免堆叠
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    
    // 根据当前语言选择语音
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
    // 1. 从服务获取数据
    const packet = signalProcessor.getDataSnapshot();
    const isConnected = signalProcessor.getIsConnected();
    const isSimMode = signalProcessor.isSimulationMode();
    
    setIsDeviceConnected(isConnected);
    setIsSimulating(isSimMode);

    // 2. 更新波形历史
    setWaveData(prev => {
      // 只有当有新数据时才添加
      const newData = [...prev, packet.raw];
      if (newData.length > HISTORY_LENGTH) {
        return newData.slice(newData.length - HISTORY_LENGTH);
      }
      return newData;
    });

    // 3. 更新指标
    setBands(packet.bands);
    setMetrics(packet.metrics);

    // 4. 语音反馈逻辑
    const now = Date.now();
    
    // 状态 1: 进入冥想状态 (Excellent...)
    // 冷却时间 15s
    if (packet.metrics.isMeditating && (now - lastVoiceTime.current > 15000) && appState === AppState.RUNNING) {
      speak(t.voice_feedback);
      lastVoiceTime.current = now;
    } 
    // 状态 2: 摇晃/分心状态 (Focus on breathing...)
    // 仅在运行中，且非冥想状态，且放松指数较低时触发
    // 冷却时间 8s
    else if (!packet.metrics.isMeditating && packet.metrics.relaxation < 0.6 && (now - lastVoiceTime.current > 8000) && appState === AppState.RUNNING) {
       speak(t.focus_breath);
       lastVoiceTime.current = now;
    }
  };

  const handleConnect = async () => {
    if (isSimulating) {
        // 如果正在模拟，先关闭模拟
        handleSimulation();
        return;
    }

    if (!isDeviceConnected) {
        // Pass the user-entered Device ID to the connection service
        const success = await signalProcessor.connect(deviceId);
        if (success) {
            setIsDeviceConnected(true);
            handleStartMonitoring();
        } else {
            // 连接失败提示
            alert("Serial Connection Failed. Ensure your device is connected and ID is correct.");
        }
    } else {
        await signalProcessor.disconnect();
        setIsDeviceConnected(false);
        handleStopMonitoring();
    }
  };

  const handleSimulation = async () => {
    if (!isSimulating) {
        // 请求运动传感器权限 (iOS)
        const granted = await signalProcessor.requestMotionPermission();
        if (granted) {
            signalProcessor.startSimulation();
            setIsSimulating(true);
            setIsDeviceConnected(true);
            handleStartMonitoring();
        } else {
            alert("Motion sensor permission required for simulation mode.");
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
          setWaveData([]); // 清空旧数据
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
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col font-sans selection:bg-sky-500/30">
      {/* 头部 Header */}
      <header className="px-6 py-4 flex flex-col md:flex-row items-center justify-between bg-slate-900/80 backdrop-blur-md sticky top-0 z-50 border-b border-slate-800 gap-4 md:gap-0">
        <WaboLogo />
        <div className="flex flex-wrap items-center justify-center gap-3">
          {/* 语言切换 */}
          <button 
             onClick={toggleLanguage}
             className="p-2 text-slate-400 hover:text-white transition-colors"
             title="Switch Language"
          >
             <Languages size={20} />
          </button>

          {/* 设备 ID 输入 - 仅当未连接和未模拟时显示 */}
          {!isDeviceConnected && !isSimulating && (
            <div className="flex items-center bg-slate-800 rounded-lg border border-slate-700 px-3 py-2">
                <Hash size={14} className="text-slate-500 mr-2" />
                <input 
                    type="text" 
                    value={deviceId}
                    onChange={(e) => setDeviceId(e.target.value)}
                    placeholder="ID: 123456"
                    className="bg-transparent border-none outline-none w-24 text-sm font-mono text-slate-200 placeholder-slate-600 focus:ring-0"
                    maxLength={6}
                />
            </div>
          )}

          {/* 模拟模式按钮 */}
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

          {/* 连接按钮 - 如果正在模拟则禁用或隐藏 */}
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
                {isDeviceConnected ? t.disconnect_btn : t.connect_btn}
              </button>
          )}

          {/* 开始/停止监测按钮 */}
          {isDeviceConnected && (
            <button 
                onClick={appState === AppState.RUNNING ? handleStopMonitoring : handleStartMonitoring}
                className={`flex items-center gap-2 px-5 py-2 rounded-lg font-semibold transition-all shadow-lg ${
                appState === AppState.RUNNING 
                ? 'bg-red-500/10 text-red-400 border border-red-500/50 hover:bg-red-500/20' 
                : 'bg-sky-600 hover:bg-sky-500 text-white shadow-sky-500/20'
                }`}
            >
                {appState === AppState.RUNNING ? <><Pause size={18} /> {t.stop_btn}</> : <><Play size={18} /> {t.start_btn}</>}
            </button>
          )}
        </div>
      </header>

      {/* 主要内容区域 */}
      <main className="flex-1 container mx-auto px-4 py-6 max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* 左侧栏: 核心可视化 */}
        <div className="lg:col-span-7 flex flex-col gap-6">
          {/* 主视觉卡片 */}
          <div className="flex-1 bg-gradient-to-b from-slate-800/30 to-slate-900/30 border border-slate-700/50 rounded-2xl relative overflow-hidden flex flex-col items-center justify-center min-h-[400px]">
             {/* 背景网格 */}
             <div className="absolute inset-0 opacity-10" 
                  style={{ backgroundImage: 'linear-gradient(#334155 1px, transparent 1px), linear-gradient(90deg, #334155 1px, transparent 1px)', backgroundSize: '40px 40px' }}>
             </div>
             
             {isSimulating && (
                 <div className="absolute top-4 left-4 px-2 py-1 bg-amber-500/20 text-amber-400 text-xs rounded border border-amber-500/40 font-mono">
                    SIMULATION MODE
                 </div>
             )}

             <AlphaVisualizer 
                alphaPower={bands.alpha}
                relaxationScore={metrics.relaxation}
                isMeditating={metrics.isMeditating}
                textMap={t}
             />
          </div>

          {/* 波形图 */}
          <WaveChart data={waveData} title={t.realtime_eeg} />
        </div>

        {/* 右侧栏: 详细数据 */}
        <div className="lg:col-span-5 flex flex-col gap-4">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="text-sky-400" size={20} />
            <h3 className="text-lg font-semibold text-slate-200">{t.analysis_title}</h3>
          </div>

          <div className="grid grid-cols-1 gap-3">
             <MetricCard 
                label={t.alpha_desc} 
                freqRange="8 - 14 Hz" 
                value={bands.alpha} 
                max={100} 
                color="#38bdf8" // sky-400
             />
             <MetricCard 
                label={t.theta_desc} 
                freqRange="4 - 8 Hz" 
                value={bands.theta} 
                max={100} 
                color="#a78bfa" // violet-400
             />
             <MetricCard 
                label={t.beta_desc} 
                freqRange="12 - 28 Hz" 
                value={bands.beta} 
                max={100} 
                color="#f472b6" // pink-400
             />
             <div className="grid grid-cols-2 gap-3">
               <MetricCard 
                  label={t.delta_desc} 
                  freqRange="0.5 - 4 Hz" 
                  value={bands.delta} 
                  max={50} 
                  color="#94a3b8" // slate-400
               />
               <MetricCard 
                  label={t.gamma_desc} 
                  freqRange="25 - 40 Hz" 
                  value={bands.gamma} 
                  max={50} 
                  color="#fbbf24" // amber-400
               />
             </div>
          </div>

          {/* 统计盒子 */}
          <div className="mt-4 p-4 bg-slate-800/50 rounded-xl border border-slate-700">
             <div className="flex justify-between items-center mb-4">
               <span className="text-slate-400 text-sm">{t.relaxation_index}</span>
               <span className="text-2xl font-bold text-white">{metrics.relaxation.toFixed(2)}</span>
             </div>
             <div className="w-full bg-slate-900 h-2 rounded-full overflow-hidden">
               <div 
                 className={`h-full transition-all duration-500 ${metrics.isMeditating ? 'bg-green-500' : 'bg-blue-500'}`} 
                 style={{ width: `${Math.min(100, metrics.relaxation * 100)}%` }}
               />
             </div>
             <div className="mt-4 flex justify-between items-center">
               <span className="text-slate-400 text-sm">{t.attention_index}</span>
               <span className="text-xl font-bold text-white">{metrics.attention.toFixed(2)}</span>
             </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
