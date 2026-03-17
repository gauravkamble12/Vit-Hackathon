import { useState, useEffect, useRef, forwardRef } from "react";
import { motion } from "framer-motion";
import { AreaChart, Area, ResponsiveContainer, YAxis } from "recharts";
import { Heart } from "lucide-react";

const generatePulseData = (isFake: boolean) => {
  const data = [];
  for (let i = 0; i < 60; i++) {
    const base = isFake
      ? Math.random() * 0.3 + 0.1
      : Math.sin(i * 0.3) * 0.4 + 0.5 + (Math.random() * 0.08);
    data.push({ t: i, value: base });
  }
  return data;
};

interface PulseWaveformProps {
  isFake: boolean;
  bpm: number;
}

const PulseWaveform = forwardRef<HTMLDivElement, PulseWaveformProps>(({ isFake, bpm }, ref) => {
  const [data, setData] = useState(() => generatePulseData(isFake));
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setData(prev => {
        const next = [...prev.slice(1)];
        const i = prev[prev.length - 1].t + 1;
        const value = isFake
          ? Math.random() * 0.3 + 0.1
          : Math.sin(i * 0.3) * 0.4 + 0.5 + (Math.random() * 0.08);
        next.push({ t: i, value });
        return next;
      });
    }, 80);
    return () => clearInterval(intervalRef.current);
  }, [isFake]);

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="forensic-card"
    >
      <div className="forensic-section-header">
        <span className="forensic-label">rPPG Pulse Signal</span>
        <div className="flex items-center gap-3">
          <motion.div
            animate={!isFake ? { scale: [1, 1.15, 1] } : {}}
            transition={!isFake ? { duration: 0.8, repeat: Infinity, ease: "easeInOut" } : {}}
            className="flex items-center gap-1.5"
          >
            <Heart className={`w-3.5 h-3.5 ${isFake ? 'text-destructive' : 'text-success'}`} />
            <span className={`font-mono text-xs font-bold ${isFake ? 'text-destructive' : 'text-success'}`}>
              {bpm} BPM
            </span>
          </motion.div>
          <div className={isFake ? 'pulse-dot-live' : 'pulse-dot-real'} />
        </div>
      </div>
      <div className="h-32 p-2">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="pulseGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={isFake ? 'hsl(0,84%,60%)' : 'hsl(210,100%,50%)'} stopOpacity={0.35} />
                <stop offset="100%" stopColor={isFake ? 'hsl(0,84%,60%)' : 'hsl(210,100%,50%)'} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <YAxis domain={[0, 1]} hide />
            <Area
              type="monotone"
              dataKey="value"
              stroke={isFake ? 'hsl(0,84%,60%)' : 'hsl(210,100%,50%)'}
              strokeWidth={2}
              fill="url(#pulseGradient)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </motion.div>
  );
});

PulseWaveform.displayName = "PulseWaveform";

export default PulseWaveform;
