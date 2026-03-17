import { forwardRef } from "react";
import { motion } from "framer-motion";
import { Shield, ShieldAlert, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

interface VerdictPanelProps {
  isFake: boolean;
  confidence: number;
  reasons: string[];
  modelName: string;
  latency: number;
}

const VerdictPanel = forwardRef<HTMLDivElement, VerdictPanelProps>(({ isFake, confidence, reasons, modelName, latency }, ref) => {
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className={isFake ? "forensic-card-alert" : "forensic-card"}
    >
      {/* Verdict header */}
      <div className={`p-4 ${isFake ? 'bg-destructive/5' : 'bg-success/5'} border-b border-border/60`}>
        <div className="flex items-center gap-3">
          <motion.div
            initial={{ rotate: -20, scale: 0 }}
            animate={{ rotate: 0, scale: 1 }}
            transition={{ type: "spring", stiffness: 200, delay: 0.15 }}
          >
            {isFake ? (
              <div className="p-2 bg-destructive/10 rounded-lg">
                <ShieldAlert className="w-6 h-6 text-destructive" />
              </div>
            ) : (
              <div className="p-2 bg-success/10 rounded-lg">
                <Shield className="w-6 h-6 text-success" />
              </div>
            )}
          </motion.div>
          <div>
            <motion.h2
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 }}
              className={`text-2xl font-semibold tracking-tight ${isFake ? 'text-destructive' : 'text-success'}`}
            >
              {isFake ? "DEEPFAKE" : "AUTHENTIC"}
            </motion.h2>
            <p className="text-[11px] font-mono text-muted-foreground mt-0.5 flex items-center gap-1.5">
              {isFake ? (
                <><XCircle className="w-3 h-3 text-destructive" /> Biological verification failed</>
              ) : (
                <><CheckCircle2 className="w-3 h-3 text-success" /> Biological verification passed</>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Confidence bar */}
      <div className="p-4 space-y-3">
        <div>
          <div className="flex justify-between mb-2">
            <span className="forensic-label">Confidence</span>
            <motion.span
              key={confidence}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className={`forensic-value font-bold ${isFake ? 'text-destructive' : 'text-success'}`}
            >
              {confidence.toFixed(1)}%
            </motion.span>
          </div>
          <div className="h-2 bg-muted/60 rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${confidence}%` }}
              transition={{ duration: 1.2, ease: "easeOut" }}
              className={`confidence-bar h-full rounded-full ${isFake ? 'bg-gradient-to-r from-destructive/80 to-destructive' : 'bg-gradient-to-r from-success/80 to-success'}`}
            />
          </div>
        </div>

        {/* Model info */}
        <div className="flex gap-4 text-[10px] font-mono text-muted-foreground/70">
          <span className="px-2 py-0.5 bg-muted/30 rounded">Model: {modelName}</span>
          <span className="px-2 py-0.5 bg-muted/30 rounded">Latency: {latency}ms</span>
        </div>

        {/* Reasons */}
        {reasons.length > 0 && (
          <div className="space-y-2 pt-3 border-t border-border/40">
            <span className="forensic-label">Flagged Indicators</span>
            {reasons.map((reason, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.08 }}
                className="flex items-start gap-2 p-1.5 rounded-md bg-warning/5 hover:bg-warning/10 transition-colors"
              >
                <AlertTriangle className="w-3 h-3 text-warning flex-shrink-0 mt-0.5" />
                <span className="text-xs text-foreground/80 leading-tight">{reason}</span>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
});

VerdictPanel.displayName = "VerdictPanel";

export default VerdictPanel;
