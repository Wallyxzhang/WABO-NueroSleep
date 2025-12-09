import React from 'react';

interface AlphaVisualizerProps {
  alphaPower: number;
  relaxationScore: number;
  isMeditating: boolean;
  textMap: any; // 接收语言包
}

export const AlphaVisualizer: React.FC<AlphaVisualizerProps> = ({ alphaPower, relaxationScore, isMeditating, textMap }) => {
  // 归一化大小用于可视化
  const coreSize = 100 + (relaxationScore * 50); // 放松时变大
  const glowOpacity = Math.min(1, relaxationScore * 0.8);
  const pulseSpeed = isMeditating ? '3s' : '1s';
  const color = isMeditating ? 'rgb(56, 189, 248)' : 'rgb(148, 163, 184)'; // 天蓝 vs 石板灰

  return (
    <div className="relative flex flex-col items-center justify-center py-10">
      {/* 状态文本 */}
      <div className="absolute top-0 text-center z-10">
        <h2 className="text-3xl font-light text-white tracking-tight">
          {isMeditating ? textMap.meditation_state : textMap.active_mind}
        </h2>
        <p className="text-slate-400 text-sm mt-1 font-mono">
          {textMap.alpha_index}: {alphaPower.toFixed(1)} uV²
        </p>
      </div>

      {/* 可视化圆环 */}
      <div className="relative w-80 h-80 flex items-center justify-center mt-8">
        {/* 外环 - 呼吸效果 */}
        <div 
          className="absolute rounded-full border border-sky-500/30"
          style={{
            width: `${coreSize * 2.5}px`,
            height: `${coreSize * 2.5}px`,
            transition: 'all 1s ease-out',
            animation: `ping ${pulseSpeed} cubic-bezier(0, 0, 0.2, 1) infinite`
          }}
        />
        
        {/* 光晕层 */}
        <div 
          className="absolute rounded-full blur-3xl bg-sky-500"
          style={{
            width: `${coreSize * 2}px`,
            height: `${coreSize * 2}px`,
            opacity: glowOpacity * 0.4,
            transition: 'all 0.5s ease-out'
          }}
        />

        {/* 核心圆 */}
        <div 
          className="rounded-full shadow-2xl backdrop-blur-md flex items-center justify-center transition-all duration-700"
          style={{
            width: `${coreSize}px`,
            height: `${coreSize}px`,
            background: `radial-gradient(circle at 30% 30%, ${color}, rgba(15, 23, 42, 0.8))`,
            boxShadow: `0 0 ${relaxationScore * 40}px ${color}`
          }}
        >
          <span className="text-2xl font-bold text-white drop-shadow-md">
            {(relaxationScore * 100).toFixed(0)}%
          </span>
        </div>
      </div>
      
      <div className="mt-8 text-center">
         <div className="inline-flex items-center px-4 py-2 rounded-full bg-slate-800 border border-slate-700">
            <div className={`w-3 h-3 rounded-full mr-2 ${isMeditating ? 'bg-green-400 shadow-[0_0_10px_rgba(74,222,128,0.8)]' : 'bg-amber-400'}`}></div>
            <span className="text-sm font-medium text-slate-200">
              {isMeditating ? textMap.target_achieved : textMap.focus_breath}
            </span>
         </div>
      </div>
    </div>
  );
};