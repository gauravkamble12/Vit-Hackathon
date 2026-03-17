import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { motion } from "framer-motion";

interface VideoFeedProps {
  isAnalyzing: boolean;
  mode: "upload" | "live" | "webcam";
  onStreamReady?: () => void;
}

export interface VideoFeedHandle {
  /** Capture the current video frame as a PNG File for analysis */
  captureFrame: () => File | null;
}

const FaceMeshOverlay = () => (
  <svg className="absolute inset-0 w-full h-full" viewBox="0 0 400 300" fill="none">
    <g stroke="hsl(210,100%,50%)" strokeWidth="0.5" opacity="0.6">
      <ellipse cx="200" cy="155" rx="65" ry="80" />
      <ellipse cx="178" cy="135" rx="16" ry="8" />
      <ellipse cx="222" cy="135" rx="16" ry="8" />
      <line x1="200" y1="130" x2="200" y2="165" />
      <line x1="192" y1="165" x2="208" y2="165" />
      <ellipse cx="200" cy="185" rx="22" ry="8" />
      <line x1="178" y1="135" x2="200" y2="110" />
      <line x1="222" y1="135" x2="200" y2="110" />
      <line x1="178" y1="135" x2="192" y2="165" />
      <line x1="222" y1="135" x2="208" y2="165" />
      <line x1="192" y1="165" x2="200" y2="185" />
      <line x1="208" y1="165" x2="200" y2="185" />
      <rect x="185" y="98" width="30" height="18" rx="2" stroke="hsl(142,70%,45%)" strokeDasharray="3 2" opacity="0.8" />
      <text x="185" y="94" fill="hsl(142,70%,45%)" fontSize="6" fontFamily="monospace" opacity="0.8">ROI: FOREHEAD</text>
    </g>
    {[
      [178, 135], [222, 135], [200, 165], [200, 185], [200, 110],
      [165, 155], [235, 155], [185, 200], [215, 200],
    ].map(([x, y], i) => (
      <circle key={i} cx={x} cy={y} r="2" fill="hsl(210,100%,50%)" opacity="0.8" />
    ))}
  </svg>
);

const VideoFeed = forwardRef<VideoFeedHandle, VideoFeedProps>(({ isAnalyzing, mode, onStreamReady }, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [streamActive, setStreamActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Expose captureFrame to parent component via ref
  useImperativeHandle(ref, () => ({
    captureFrame: (): File | null => {
      const video = videoRef.current;
      if (!video || !streamRef.current || video.videoWidth === 0) return null;

      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(video, 0, 0);

        // Convert canvas to blob synchronously via toDataURL → File
        const dataUrl = canvas.toDataURL("image/png");
        const byteString = atob(dataUrl.split(",")[1]);
        const ab = new ArrayBuffer(byteString.length);
        const ia = new Uint8Array(ab);
        for (let i = 0; i < byteString.length; i++) {
          ia[i] = byteString.charCodeAt(i);
        }
        return new File([ab], "live_frame.png", { type: "image/png" });
      } catch {
        return null;
      }
    },
  }));

  // Cleanup stream on unmount or mode change
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
    };
  }, [mode]);

  const startWebcam = async () => {
    setError(null);
    try {
      // Stop any existing stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: "user" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setStreamActive(true);
      onStreamReady?.();
    } catch (err) {
      const msg = err instanceof Error && err.name === "NotAllowedError"
        ? "Camera access denied. Please allow camera permission in your browser."
        : "Could not access webcam. Please check your device.";
      setError(msg);
      setStreamActive(false);
    }
  };

  const startScreenCapture = async () => {
    setError(null);
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "monitor" } as any,
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      setStreamActive(true);
      onStreamReady?.();

      // Listen for when user stops sharing
      stream.getVideoTracks()[0].addEventListener("ended", () => {
        setStreamActive(false);
        streamRef.current = null;
      });
    } catch (err) {
      const msg = err instanceof Error && err.name === "NotAllowedError"
        ? "Screen sharing was cancelled."
        : "Could not capture screen.";
      setError(msg);
      setStreamActive(false);
    }
  };

  const handleStartCapture = () => {
    if (mode === "webcam") {
      startWebcam();
    } else if (mode === "live") {
      startScreenCapture();
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="forensic-card"
    >
      <div className="forensic-section-header">
        <span className="forensic-label">
          {mode === "upload" ? "Uploaded Media" : mode === "live" ? "Live Screen Capture" : "Webcam Feed"}
        </span>
        <div className="flex items-center gap-2">
          {streamActive && (
            <>
              <div className="pulse-dot-live" />
              <span className="text-[10px] font-mono uppercase text-muted-foreground">
                {isAnalyzing ? "Analyzing..." : "Streaming"}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="relative bg-background rounded-lg m-2 aspect-video overflow-hidden">
        {/* Video element for webcam/screen */}
        {(mode === "webcam" || mode === "live") && (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`absolute inset-0 w-full h-full object-cover ${streamActive ? 'block' : 'hidden'}`}
          />
        )}

        {/* Placeholder when no stream */}
        {(!streamActive || mode === "upload") && (
          <div className="absolute inset-0 bg-gradient-to-br from-secondary to-background flex flex-col items-center justify-center gap-3">
            {mode === "upload" ? (
              <>
                <div className="w-24 h-24 rounded-full bg-muted/30 border border-border" />
                <div className="absolute bottom-3 left-3 flex items-center gap-2">
                  <span className="text-[9px] font-mono text-muted-foreground">RES: 1920×1080</span>
                  <span className="text-[9px] font-mono text-muted-foreground">FPS: 30</span>
                </div>
              </>
            ) : (
              <>
                {error && (
                  <p className="text-xs text-destructive font-mono px-4 text-center">{error}</p>
                )}
                <button
                  onClick={handleStartCapture}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-xs font-medium hover:bg-primary/90 transition-colors"
                >
                  {mode === "webcam" ? "🎥 Open Camera" : "🖥️ Share Screen"}
                </button>
                <p className="text-[10px] font-mono text-muted-foreground text-center px-4">
                  {mode === "webcam"
                    ? "Click to start webcam for real-time deepfake detection"
                    : "Share your entire screen to scan any app, website, or video for deepfakes"}
                </p>
              </>
            )}
          </div>
        )}

        {/* Face mesh overlay */}
        {isAnalyzing && streamActive && <FaceMeshOverlay />}

        {/* Scan line */}
        {isAnalyzing && streamActive && (
          <div className="scan-line animate-scan" />
        )}

        {/* Live info overlay */}
        {streamActive && (
          <div className="absolute bottom-3 left-3 flex items-center gap-2">
            <span className="text-[9px] font-mono text-muted-foreground bg-background/70 px-1.5 py-0.5 rounded">
              {mode === "webcam" ? "WEBCAM" : "SCREEN"} • LIVE
            </span>
          </div>
        )}
      </div>
    </motion.div>
  );
});

VideoFeed.displayName = "VideoFeed";

export default VideoFeed;
