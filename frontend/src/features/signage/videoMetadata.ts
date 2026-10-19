/** Reads width, height and duration of an MP4 in the browser; the API wants them for videos. */
export function readVideoMetadata(file: Blob): Promise<{ width: number; height: number; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const finish = (action: () => void) => { window.clearTimeout(timer); URL.revokeObjectURL(url); video.removeAttribute('src'); action(); };
    const timer = window.setTimeout(() => finish(() => reject(new Error('The video could not be read.'))), 15_000);
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => finish(() => {
      const durationMs = Math.round(video.duration * 1000);
      if (video.videoWidth > 0 && video.videoHeight > 0 && Number.isFinite(durationMs) && durationMs > 0) resolve({ width: video.videoWidth, height: video.videoHeight, durationMs });
      else reject(new Error('The video has no readable size or duration.'));
    });
    video.onerror = () => finish(() => reject(new Error('The browser cannot read this video. Use an H.264 MP4.')));
    video.src = url;
  });
}
