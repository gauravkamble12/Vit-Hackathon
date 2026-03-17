import { motion } from "framer-motion";
import { Monitor, Video, Upload as UploadIcon } from "lucide-react";

type Mode = "upload" | "live" | "webcam";

interface ModeSelectorProps {
  activeMode: Mode;
  onModeChange: (mode: Mode) => void;
}

const modes = [
  { id: "upload" as Mode, label: "Upload", icon: UploadIcon },
  { id: "live" as Mode, label: "Live Screen", icon: Monitor },
  { id: "webcam" as Mode, label: "Webcam", icon: Video },
];

const ModeSelector = ({ activeMode, onModeChange }: ModeSelectorProps) => {
  return (
    <div className="flex gap-1 p-1 bg-secondary/80 rounded-lg backdrop-blur-sm border border-border/40">
      {modes.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => onModeChange(id)}
          className={`relative flex items-center gap-2 px-4 py-2 rounded-md text-xs font-medium transition-all duration-200 ${
            activeMode === id ? "text-foreground" : "text-muted-foreground hover:text-foreground/70"
          }`}
        >
          {activeMode === id && (
            <motion.div
              layoutId="activeMode"
              className="absolute inset-0 bg-card/90 rounded-md border border-border/40"
              style={{ boxShadow: "0 2px 8px rgba(0,0,0,0.3)" }}
              transition={{ type: "spring", bounce: 0.15, duration: 0.4 }}
            />
          )}
          <span className="relative z-10 flex items-center gap-2">
            <Icon className="w-3.5 h-3.5" />
            {label}
          </span>
        </button>
      ))}
    </div>
  );
};

export default ModeSelector;
