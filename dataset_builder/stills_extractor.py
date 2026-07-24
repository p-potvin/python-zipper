import os
import gc
import glob
import subprocess
import torch
from PIL import Image, ImageEnhance, ImageFilter
from diffusers import FluxPipeline

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
VIDEO_INPUT_DIR = "input_videos/"
OUTPUT_STILLS_DIR = "restored_stills/"
TEMP_KEYFRAME_DIR = "temp_keyframes/"

MODEL_PATH = r"D:\comfyUI\resources\ComfyUI\models\diffusion_models\Flux-Klein-9b-V2-BFS-FP8-ComfyUI.safetensors"

os.makedirs(OUTPUT_STILLS_DIR, exist_ok=True)
os.makedirs(TEMP_KEYFRAME_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# Stage 1: Batch Keyframe Extraction via FFmpeg
# ---------------------------------------------------------------------------
def extract_keyframes_from_videos(input_dir: str, temp_dir: str):
    video_extensions = ("*.mp4", "*.mkv", "*.mov", "*.avi")
    video_files = []
    for ext in video_extensions:
        video_files.extend(glob.glob(os.path.join(input_dir, ext)))

    if not video_files:
        raise FileNotFoundError(f"No video files found in '{input_dir}'")

    print(f"Found {len(video_files)} video(s). Extracting I-frames...")

    for vid_path in video_files:
        base_name = os.path.splitext(os.path.basename(vid_path))[0]
        out_pattern = os.path.join(temp_dir, f"{base_name}_frame_%04d.png")

        # Select only I-frames (keyframes) and drop duplicate timestamps
        cmd = [
            "ffmpeg", "-y",
            "-i", vid_path,
            "-vf", "select='eq(pict_type,I)'",
            "-vsync", "vfr",
            out_pattern
        ]
        
        try:
            subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        except subprocess.CalledProcessError as e:
            print(f"FFmpeg error processing {vid_path}: {e.stderr.decode()}")

    extracted_frames = sorted(glob.glob(os.path.join(temp_dir, "*.png")))
    print(f"Extracted {len(extracted_frames)} keyframe(s) across all videos.")
    return extracted_frames


# Execute FFmpeg before GPU allocations
extracted_keyframes = extract_keyframes_from_videos(VIDEO_INPUT_DIR, TEMP_KEYFRAME_DIR)

# ---------------------------------------------------------------------------
# Stage 2: Load Model & Process
# ---------------------------------------------------------------------------
print(f"\nLoading local FLUX model from: {MODEL_PATH}")

pipe = FluxPipeline.from_single_file(
    MODEL_PATH,
    torch_dtype=torch.bfloat16
)

# VRAM Optimizations for 12GB budget
pipe.enable_sequential_cpu_offload()
pipe.vae.enable_slicing()
pipe.vae.enable_tiling()

prompt = (
    "High-resolution 35mm raw photograph, realistic film grain, sharp optical lens focus, "
    "subsurface scattering, fine skin details, natural dynamic range, studio lighting"
)

print("\nStarting Img2Img batch processing...")

for img_path in extracted_keyframes:
    filename = os.path.basename(img_path)
    save_path = os.path.join(OUTPUT_STILLS_DIR, filename)

    # 1. Image Pre-processing
    raw_frame = Image.open(img_path).convert("RGB")
    
    # Mild spatial blur to break up macroblock boundaries prior to latent encoding
    preprocessed = raw_frame.filter(ImageFilter.SMOOTH_MORE)
    
    # Expand clipped Rec.709 dynamic range
    enhancer = ImageEnhance.Contrast(preprocessed)
    preprocessed = enhancer.enhance(1.08)

    # 2. Diffusion Pass
    with torch.inference_mode():
        restored_still = pipe(
            prompt=prompt,
            image=preprocessed,
            strength=0.35,  # Preserves spatial structure while overwriting video compression
            guidance_scale=3.5,
            num_inference_steps=20,
            generator=torch.Generator("cuda").manual_seed(42)
        ).images[0]

    restored_still.save(save_path, quality=98)
    print(f"Saved: {save_path}")

    # Explicit memory cleanup per iteration
    del raw_frame, preprocessed, restored_still
    gc.collect()
    torch.cuda.empty_cache()

# Cleanup temporary frame extractions
for f in extracted_keyframes:
    os.remove(f)

print("\nPipeline execution finished successfully.")