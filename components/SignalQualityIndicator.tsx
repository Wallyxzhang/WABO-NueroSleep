import React from 'react';
import { Wifi, WifiOff, AlertTriangle } from 'lucide-react';

interface SignalQualityIndicatorProps {
  quality: number; // 0.0 to 1.0
  isConnected: boolean;
  language: string;
}

export const SignalQualityIndicator: React.FC<SignalQualityIndicatorProps> = ({ quality, isConnected, language }) => {
  if (!isConnected) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-800/80 rounded-lg border border-slate-700/50">
        <WifiOff size={16} className="text-slate-500" />
        <span className="text-xs text-slate-500 font-mono uppercase">Offline</span>
      </div>
    );
  }

  // Determine state
  let state = 'good';
  if (quality < 0.1) state = 'bad';
  else if (quality < 0.8) state = 'warn';

  const t = {
      good: language === 'zh' ? '信号稳定' : 'Stable',
      warn: language === 'zh' ? '干扰检测' : 'Interference',
      bad: language === 'zh' ? '强噪音 - 请放松' : 'High Noise - Relax',
  };

  const colors = {
      good: 'text-emerald-400 bg-emerald-900/20 border-emerald-500/30',
      warn: 'text-amber-400 bg-amber-900/20 border-amber-500/30',
      bad: 'text-rose-400 bg-rose-900/20 border-rose-500/30 animate-pulse',
  };

  const iconColors = {
      good: 'text-emerald-400',
      warn: 'text-amber-400',
      bad: 'text-rose-400',
  };

  const config = {
      good: { text: t.good, style: colors.good, Icon: Wifi },
      warn: { text: t.warn, style: colors.warn, Icon: AlertTriangle },
      bad:  { text: t.bad,  style: colors.bad,  Icon: AlertTriangle },
  };

  const current = config[state as keyof typeof config];
  const Icon = current.Icon;

  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border backdrop-blur-md transition-all duration-300 ${current.style}`}>
      <Icon size={16} className={iconColors[state as keyof typeof iconColors]} />
      <span className="text-xs font-semibold tracking-wide uppercase">
        {current.text}
      </span>
      {state === 'good' && (
          <div className="flex gap-0.5 items-end h-3 ml-1">
              <div className="w-1 bg-emerald-500/40 h-[40%] rounded-sm"></div>
              <div className="w-1 bg-emerald-500/60 h-[60%] rounded-sm"></div>
              <div className="w-1 bg-emerald-500 h-full rounded-sm"></div>
          </div>
      )}
    </div>
  );
};