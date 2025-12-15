import React, { useRef, useEffect } from 'react';

interface AlphaVisualizerProps {
  alphaPower: number;
  relaxationScore: number;
  isMeditating: boolean;
  textMap: any;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  phase: number;
}

export const AlphaVisualizer: React.FC<AlphaVisualizerProps> = ({ alphaPower, relaxationScore, isMeditating, textMap }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const frameIdRef = useRef<number>(0);
  
  // 用于平滑动画的内部状态
  const smoothState = useRef({
      alpha: 0,
      relaxation: 0
  });

  // Initialize particles
  useEffect(() => {
    if (!particlesRef.current.length) {
      for (let i = 0; i < 150; i++) {
        particlesRef.current.push({
          x: Math.random() * 300,
          y: Math.random() * 300,
          vx: (Math.random() - 0.5) * 0.5,
          vy: (Math.random() - 0.5) * 0.5,
          radius: Math.random() * 1.5 + 0.5,
          alpha: Math.random() * 0.5 + 0.2,
          phase: Math.random() * Math.PI * 2
        });
      }
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const centerX = width / 2;
    const centerY = height / 2;

    const render = () => {
      // 1. 线性插值 (LERP) 使动画状态平滑过渡
      // 每一帧只移动 5% 的距离，消除了数值跳动
      smoothState.current.alpha += (alphaPower - smoothState.current.alpha) * 0.05;
      smoothState.current.relaxation += (relaxationScore - smoothState.current.relaxation) * 0.05;

      const currentRel = smoothState.current.relaxation;
      const currentAlpha = smoothState.current.alpha;

      // Clear canvas with a very slight trail effect
      ctx.fillStyle = 'rgba(15, 23, 42, 0.2)'; 
      ctx.fillRect(0, 0, width, height);

      const isRelaxed = currentRel > 0.6;
      const coreRadius = 40 + currentAlpha * 0.5; 
      
      particlesRef.current.forEach((p, i) => {
        p.phase += 0.05;
        
        if (isRelaxed) {
            // --- CONDENSED MODE (Light Ball) ---
            const angle = (i / particlesRef.current.length) * Math.PI * 2 + p.phase * 0.1;
            // 松弛状态下收缩
            const tightness = 1 - Math.min(1, currentRel); 
            const targetDist = coreRadius * (0.8 + Math.sin(p.phase)*0.2) + (tightness * 100);
            
            const targetX = centerX + Math.cos(angle) * targetDist;
            const targetY = centerY + Math.sin(angle) * targetDist;
            
            p.x += (targetX - p.x) * 0.05;
            p.y += (targetY - p.y) * 0.05;
            
            p.x += (Math.random() - 0.5) * 2;
            p.y += (Math.random() - 0.5) * 2;

        } else {
            // --- SCATTERED MODE (Starlight) ---
            p.x += p.vx + (Math.random()-0.5)*0.5;
            p.y += p.vy + (Math.random()-0.5)*0.5;
            
            if (p.x < 0) p.x = width;
            if (p.x > width) p.x = 0;
            if (p.y < 0) p.y = height;
            if (p.y > height) p.y = 0;
            
            // 如果非常不放松，粒子会轻微远离中心
            const dx = p.x - centerX;
            const dy = p.y - centerY;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (dist < 50) {
                p.vx += dx * 0.001;
                p.vy += dy * 0.001;
            }
        }

        ctx.beginPath();
        const flicker = 0.5 + 0.5 * Math.sin(p.phase);
        ctx.globalAlpha = p.alpha * flicker;
        
        // Color transition
        if (isMeditating) {
            ctx.fillStyle = `hsl(160, 100%, ${50 + flicker * 50}%)`; // Greenish Cyan
        } else if (isRelaxed) {
            ctx.fillStyle = `hsl(200, 100%, ${60 + flicker * 40}%)`; // Sky Blue
        } else {
            ctx.fillStyle = `hsl(220, 20%, ${80 + flicker * 20}%)`; // Pale Blue/White
        }

        ctx.arc(p.x, p.y, p.radius * (isRelaxed ? 1.5 : 1), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
      });

      // Draw Core Glow
      if (currentRel > 0.3) {
          const glowSize = coreRadius * currentRel * 1.5;
          const gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, glowSize);
          
          if (isMeditating) {
            gradient.addColorStop(0, 'rgba(52, 211, 153, 0.4)'); // Emerald
            gradient.addColorStop(1, 'rgba(52, 211, 153, 0)');
          } else {
            gradient.addColorStop(0, 'rgba(56, 189, 248, 0.3)'); // Sky
            gradient.addColorStop(1, 'rgba(56, 189, 248, 0)');
          }
          
          ctx.globalCompositeOperation = 'screen';
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(centerX, centerY, glowSize, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
      }

      frameIdRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(frameIdRef.current);
    };
  }, [relaxationScore, isMeditating, alphaPower]);

  return (
    <div className="relative flex flex-col items-center justify-center h-full w-full min-h-[400px]">
      <div className="absolute top-6 text-center z-10 pointer-events-none">
        <h2 className={`text-3xl font-light tracking-tight transition-colors duration-1000 ${isMeditating ? 'text-emerald-400' : 'text-slate-100'}`}>
          {isMeditating ? textMap.meditation_state : textMap.active_mind}
        </h2>
        <p className="text-slate-400 text-sm mt-1 font-mono transition-opacity duration-500">
          {textMap.alpha_index}: {alphaPower.toFixed(1)}
        </p>
      </div>

      <canvas 
        ref={canvasRef}
        width={400}
        height={400}
        className="w-full h-full max-w-[400px] max-h-[400px]"
      />
      
      <div className="absolute bottom-6 text-center pointer-events-none">
         <div className={`inline-flex items-center px-4 py-2 rounded-full border backdrop-blur-md transition-all duration-1000 ${
             isMeditating 
             ? 'bg-emerald-900/30 border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.3)]' 
             : 'bg-slate-800/50 border-slate-700'
         }`}>
            <span className={`text-sm font-medium transition-colors duration-1000 ${isMeditating ? 'text-emerald-300' : 'text-slate-300'}`}>
              {isMeditating ? textMap.target_achieved : textMap.focus_breath}
            </span>
         </div>
      </div>
    </div>
  );
};
