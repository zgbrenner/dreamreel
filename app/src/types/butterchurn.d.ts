// Minimal type declarations for the optional, lazily-loaded Butterchurn packages (MIT).
// They ship no types and are browser-only (the engine references `window` at module load), so
// they are imported ONLY via dynamic import() inside ButterchurnLayer, never at top level / in
// tests. These cover just the surface we touch.

declare module 'butterchurn' {
  export interface ButterchurnVisualizer {
    loadPreset(preset: unknown, blendTime: number): void;
    setRendererSize(width: number, height: number): void;
    render(): void;
    connectAudio(node: unknown): void;
  }
  const butterchurn: {
    createVisualizer(
      audioContext: unknown,
      canvas: HTMLCanvasElement,
      opts: Record<string, unknown>,
    ): ButterchurnVisualizer;
  };
  export default butterchurn;
}

declare module 'butterchurn-presets' {
  const presets: {
    getPresets?(): Record<string, unknown>;
  };
  export default presets;
}
