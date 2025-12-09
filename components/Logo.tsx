import React from 'react';

// Recreating the WABO logo visually using SVG based on the provided image structure
export const WaboLogo: React.FC<{ className?: string }> = ({ className = "" }) => {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      {/* Icon Symbol */}
      <svg width="40" height="40" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M10 20 L30 80 L50 20 L70 80 L90 20" stroke="#0090FF" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round"/>
        <circle cx="50" cy="10" r="4" fill="#0090FF" className="animate-pulse" />
        <rect x="25" y="-10" width="4" height="20" rx="2" fill="#0090FF" className="animate-[bounce_1s_infinite]" />
        <rect x="48" y="-20" width="4" height="30" rx="2" fill="#0090FF" className="animate-[bounce_1.2s_infinite]" />
        <rect x="71" y="-10" width="4" height="20" rx="2" fill="#0090FF" className="animate-[bounce_1.4s_infinite]" />
      </svg>
      
      {/* Text */}
      <div className="flex flex-col justify-center h-full">
        <h1 className="text-2xl font-black tracking-tighter text-slate-100 leading-none">
          WABO
        </h1>
        <span className="text-xs font-bold tracking-widest text-slate-400 uppercase">
          Tech
        </span>
      </div>
    </div>
  );
};