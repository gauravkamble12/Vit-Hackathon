import { motion } from "framer-motion";
import { Clock, Activity, Cpu, Eye, ShieldCheck } from "lucide-react";

interface LogEntry {
  time: string;
  event: string;
  level: "info" | "warning" | "critical";
}

interface ForensicSidebarProps {
  confidence: number;
  isFake: boolean;
  logs: LogEntry[];
  metrics: {
    framesProcessed: number;
    faceDetections: number;
    pulseReadings: number;
    anomalies: number;
  };
}

const ForensicSidebar = ({ confidence, isFake, logs, metrics }: ForensicSidebarProps) => {
  const levelColor = {
    info: "text-primary",
    warning: "text-warning",
    critical: "text-destructive",
  };

  const levelDot = {
    info: "bg-primary",
    warning: "bg-warning",
    critical: "bg-destructive",
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="space-y-3"
    >
      {/* Threat Meter */}
      <div className="forensic-card p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="forensic-label">Threat Level</span>
          {confidence > 0 && (
            <motion.span
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full ${
                isFake
                  ? "bg-destructive/15 text-destructive"
                  : "bg-success/15 text-success"
              }`}
            >
              {confidence.toFixed(1)}%
            </motion.span>
          )}
        </div>
        <div className="flex items-end gap-[3px] h-16">
          {Array.from({ length: 20 }).map((_, i) => {
            const threshold = (i / 20) * 100;
            const isActive = confidence >= threshold;
            const getColor = () => {
              if (threshold < 30) return isActive ? "bg-success" : "bg-muted/40";
              if (threshold < 60) return isActive ? "bg-warning" : "bg-muted/40";
              return isActive ? "bg-destructive" : "bg-muted/40";
            };
            return (
              <motion.div
                key={i}
                className={`threat-bar flex-1 rounded-sm ${getColor()}`}
                style={{
                  height: `${20 + i * 4}%`,
                  opacity: isActive ? 1 : 0.15,
                  animationDelay: `${i * 30}ms`,
                }}
                animate={isActive ? { opacity: [0.7, 1, 0.7] } : {}}
                transition={isActive && threshold >= 60 ? { duration: 1.5, repeat: Infinity, ease: "easeInOut" } : {}}
              />
            );
          })}
        </div>
        <div className="mt-2 flex justify-between">
          <span className="text-[10px] font-mono text-success flex items-center gap-1">
            <ShieldCheck className="w-3 h-3" /> SAFE
          </span>
          <span className="text-[10px] font-mono text-destructive">CRITICAL</span>
        </div>
      </div>

      {/* Metrics */}
      <div className="forensic-card p-4 space-y-3">
        <span className="forensic-label">Processing Metrics</span>
        {[
          { icon: Cpu, label: "Frames Processed", value: metrics.framesProcessed.toLocaleString() },
          { icon: Eye, label: "Face Detections", value: metrics.faceDetections.toLocaleString() },
          { icon: Activity, label: "Pulse Readings", value: metrics.pulseReadings.toLocaleString() },
          { icon: Clock, label: "Anomalies Found", value: metrics.anomalies.toString(), alert: metrics.anomalies > 0 },
        ].map(({ icon: Icon, label, value, alert }, idx) => (
          <motion.div
            key={label}
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: idx * 0.08 }}
            className="flex items-center justify-between group"
          >
            <div className="flex items-center gap-2">
              <div className={`p-1 rounded ${alert ? 'bg-destructive/10' : 'bg-muted/40'}`}>
                <Icon className={`w-3.5 h-3.5 ${alert ? 'text-destructive' : 'text-muted-foreground'}`} />
              </div>
              <span className="text-[11px] text-muted-foreground group-hover:text-foreground/80 transition-colors">{label}</span>
            </div>
            <motion.span
              key={value}
              initial={{ opacity: 0.5 }}
              animate={{ opacity: 1 }}
              className={`forensic-value ${alert ? 'text-destructive font-bold' : ''}`}
            >
              {value}
            </motion.span>
          </motion.div>
        ))}
      </div>

      {/* Detection Log */}
      <div className="forensic-card">
        <div className="forensic-section-header">
          <span className="forensic-label">Detection Log</span>
          <span className="text-[9px] font-mono text-muted-foreground/60">{logs.length} entries</span>
        </div>
        <div className="p-2 max-h-52 overflow-y-auto space-y-0.5">
          {logs.map((log, i) => (
            <div
              key={i}
              className="log-entry flex items-start gap-2 px-2 py-1.5 rounded hover:bg-muted/20 transition-colors"
              style={{ animationDelay: `${Math.min(i * 50, 500)}ms` }}
            >
              <span className="text-[9px] font-mono text-muted-foreground/60 whitespace-nowrap mt-0.5">{log.time}</span>
              <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${levelDot[log.level]}`} />
              <span className={`text-[11px] leading-tight ${levelColor[log.level]}`}>{log.event}</span>
            </div>
          ))}
        </div>
      </div>
    </motion.div>
  );
};

export default ForensicSidebar;
