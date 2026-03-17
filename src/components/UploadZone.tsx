import { useCallback, useState } from "react";
import { motion } from "framer-motion";
import { Upload, FileVideo, FileAudio, Image, Sparkles } from "lucide-react";

interface UploadZoneProps {
  onFileSelect: (file: File) => void;
}

const UploadZone = ({ onFileSelect }: UploadZoneProps) => {
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFileSelect(file);
  }, [onFileSelect]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFileSelect(file);
  }, [onFileSelect]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      <label
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`upload-ring forensic-card block cursor-pointer transition-all duration-300 ${
          isDragging ? 'border-primary/40 scale-[1.01]' : ''
        }`}
      >
        <input
          type="file"
          className="hidden"
          accept="image/*,video/*,audio/*"
          onChange={handleFileInput}
        />
        <div className="p-10 flex flex-col items-center gap-4 text-center relative overflow-hidden">
          {/* Background pulse rings */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <motion.div
              animate={{ scale: [1, 1.5, 1], opacity: [0.08, 0, 0.08] }}
              transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
              className="w-48 h-48 rounded-full border border-primary/20"
            />
            <motion.div
              animate={{ scale: [1, 1.8, 1], opacity: [0.06, 0, 0.06] }}
              transition={{ duration: 4, repeat: Infinity, ease: "easeInOut", delay: 0.5 }}
              className="absolute w-48 h-48 rounded-full border border-primary/10"
            />
          </div>

          {/* Upload icon with floating animation */}
          <motion.div
            animate={{ y: [0, -5, 0] }}
            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
            className="relative"
          >
            <div className="p-4 rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 border border-primary/20">
              <Upload className="w-7 h-7 text-primary" />
            </div>
            <motion.div
              animate={{ opacity: [0, 1, 0] }}
              transition={{ duration: 2, repeat: Infinity, delay: 1 }}
              className="absolute -top-1 -right-1"
            >
              <Sparkles className="w-3.5 h-3.5 text-primary/60" />
            </motion.div>
          </motion.div>

          <div>
            <p className="text-sm font-medium text-foreground">Drop media file to analyze</p>
            <p className="text-[11px] text-muted-foreground mt-1.5">Supports images, video, and audio files</p>
          </div>

          {/* File type badges */}
          <div className="flex gap-3 mt-1">
            {[
              { icon: Image, label: "IMG", color: "text-blue-400" },
              { icon: FileVideo, label: "VID", color: "text-purple-400" },
              { icon: FileAudio, label: "AUD", color: "text-emerald-400" },
            ].map(({ icon: Icon, label, color }) => (
              <div
                key={label}
                className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground bg-muted/30 px-2.5 py-1 rounded-md hover:bg-muted/50 transition-colors"
              >
                <Icon className={`w-3 h-3 ${color}`} />
                <span>{label}</span>
              </div>
            ))}
          </div>
        </div>
      </label>
    </motion.div>
  );
};

export default UploadZone;
