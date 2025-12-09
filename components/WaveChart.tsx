import React from 'react';
import { ResponsiveContainer, LineChart, Line, YAxis } from 'recharts';
import { EEGDataPoint } from '../types';

interface WaveChartProps {
  data: EEGDataPoint[];
  title: string;
}

export const WaveChart: React.FC<WaveChartProps> = ({ data, title }) => {
  return (
    <div className="w-full h-48 bg-slate-800/50 rounded-xl border border-slate-700/50 backdrop-blur-sm p-4 shadow-lg">
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">{title}</h3>
        <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
      </div>
      <div className="w-full h-32">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <YAxis domain={['auto', 'auto']} hide />
            <Line 
              type="monotone" 
              dataKey="value" 
              stroke="#0090FF" 
              strokeWidth={2} 
              dot={false} 
              isAnimationActive={false} // 性能优化：关闭动画以支持实时数据
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};