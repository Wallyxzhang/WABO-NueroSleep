import React from 'react';
import { ResponsiveContainer, BarChart, Bar, Cell } from 'recharts';

interface MetricCardProps {
  label: string;
  value: number;
  freqRange: string;
  color: string;
  max: number;
}

export const MetricCard: React.FC<MetricCardProps> = ({ label, value, freqRange, color, max }) => {
  const percentage = Math.min(100, (value / max) * 100);
  
  return (
    <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3 flex flex-col justify-between backdrop-blur-sm hover:bg-slate-800/60 transition-colors">
      <div className="flex justify-between items-start">
        <div>
          <h4 className="text-slate-200 font-semibold">{label}</h4>
          <span className="text-xs text-slate-500">{freqRange}</span>
        </div>
        <span className="text-lg font-mono font-bold" style={{ color }}>
          {value.toFixed(1)}
        </span>
      </div>
      
      {/* Simple Bar visualizer */}
      <div className="w-full bg-slate-900 rounded-full h-1.5 mt-3 overflow-hidden">
        <div 
          className="h-full rounded-full transition-all duration-300" 
          style={{ width: `${percentage}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
};