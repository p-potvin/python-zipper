import os
import sys
import shutil
import argparse
import subprocess

def install_dependencies():
    dependencies = ["transformers", "torch", "torchvision", "pillow", "timm"]
    missing = []
    
    for dep in dependencies:
        try:
            if dep == "pillow":
                __import__("PIL")
            else:
                __import__(dep)
        except ImportError:
            missing.append(dep)
            
    if missing:
        print(f"Missing required dependencies for face/person detection: {missing}")
        print("Attempting to install dependencies in the current virtual environment...")
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install"] + missing)
            print("Dependencies installed successfully.")
        except Exception as e:
            print(f"Failed to automatically install dependencies: {e}")
            print(f"Please install them manually using: pip install {' '.join(dependencies)}")
            sys.exit(1)

install_dependencies()

import time

import torch
from PIL import Image, ImageFile
from transformers import DetrImageProcessor, DetrForObjectDetection

import vw_telemetry as telemetry

DETR_MODEL = "facebook/detr-resnet-50"

# Prevent PIL from throwing errors or stalling on large images
Image.MAX_IMAGE_PIXELS = None
ImageFile.LOAD_TRUNCATED_IMAGES = True

def move_file_safe(src, dst_dir):
    if not os.path.exists(src):
        return
    filename = os.path.basename(src)
    name, ext = os.path.splitext(filename)
    dst = os.path.join(dst_dir, filename)
    counter = 1
    while os.path.exists(dst):
        dst = os.path.join(dst_dir, f"{name}_{counter}{ext}")
        counter += 1
    try:
        shutil.move(src, dst)
        print(f"Moved non-single-person image: {src} -> {dst}")
    except Exception as e:
        print(f"Error moving file {src} to {dst}: {e}")

def main():
    parser = argparse.ArgumentParser(description="Filter images by checking if they contain exactly one person.")
    parser.add_argument("--dir", required=True, help="Directory containing images to process.")
    parser.add_argument("--completed", required=True, help="Directory to move non-single-person images to.")
    parser.add_argument("--threshold", type=float, default=0.9, help="Confidence threshold for DETR detector.")
    args = parser.parse_args()

    if not os.path.exists(args.dir):
        print(f"Target directory not found: {args.dir}")
        sys.exit(1)

    os.makedirs(args.completed, exist_ok=True)

    # FIXED: Explicitly target CUDA (RTX 3060) to leverage hardware acceleration and clear thread locks
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Using device for inference: {device}")

    print("Initializing Facebook DETR-ResNet-50 object detection model...")
    load_started = time.perf_counter()
    try:
        processor = DetrImageProcessor.from_pretrained(DETR_MODEL)
        model = DetrForObjectDetection.from_pretrained(DETR_MODEL).to(device)
        model.eval()
    except Exception as e:
        print(f"Failed to load DETR model from Hugging Face: {e}")
        # A load failure is the most useful thing to know about and the easiest
        # to miss, since the process just exits.
        telemetry.record(
            provider="huggingface", runtime="transformers", model=DETR_MODEL,
            task="vision", service="dataset-builder-detect",
            status="error", error_class=type(e).__name__, error_message=str(e),
            duration_ms=round((time.perf_counter() - load_started) * 1000, 3),
        )
        telemetry.flush()
        sys.exit(1)
    load_ms = round((time.perf_counter() - load_started) * 1000, 3)

    valid_extensions = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    
    files = [
        os.path.join(args.dir, f) for f in os.listdir(args.dir)
        if os.path.isfile(os.path.join(args.dir, f)) and os.path.splitext(f)[1].lower() in valid_extensions
    ]

    if not files:
        print("No images found to analyze.")
        sys.exit(0)

    print(f"Analyzing {len(files)} images for person presence...")

    # One run per BATCH, not per image. A dataset pass is routinely thousands
    # of files, and the number worth having is throughput across the job --
    # per-image rows would bury that under their own volume.
    analysed = 0
    failed = 0
    matched = 0

    job = telemetry.run(
        model=DETR_MODEL,
        task="vision",
        provider="huggingface",
        runtime="transformers",
        service="dataset-builder-detect",
        device=str(device),
        load_ms=load_ms,
        threshold=args.threshold,
    )
    job.start()

    # FIXED: Use inference_mode instead of no_grad for better optimization performance on Ampere architecture
    with torch.inference_mode():
        for file_path in files:
            if os.path.abspath(file_path).startswith(os.path.abspath(args.completed)):
                continue

            try:
                image = Image.open(file_path).convert("RGB")
                
                # FIXED: Move tensors directly to your GPU
                inputs = processor(images=image, return_tensors="pt")
                inputs = {k: v.to(device) for k, v in inputs.items()}
                
                outputs = model(**inputs)
                
                target_sizes = torch.tensor([image.size[::-1]]).to(device)
                results = processor.post_process_object_detection(outputs, target_sizes=target_sizes, threshold=args.threshold)[0]
                
                person_count = 0
                for label in results["labels"]:
                    label_name = model.config.id2label[label.item()]
                    if label_name == "person":
                        person_count += 1
                        
                print(f"Image '{os.path.basename(file_path)}': detected {person_count} person(s)")
                analysed += 1
                if person_count == 1:
                    matched += 1
                else:
                    move_file_safe(file_path, args.completed)

            except Exception as e:
                print(f"Error processing image {file_path}: {e}")
                failed += 1
                move_file_safe(file_path, args.completed)

    # A per-image failure does not fail the job -- the file is moved aside and
    # the pass continues -- so the count is carried on the run rather than
    # flipping its status. A job where every image failed still reads as `ok`
    # by status alone, which is why image_failed is recorded next to it.
    job.set(
        image_count=analysed + failed,
        images_matched=matched,
        image_failed=failed,
    )
    job.close()
    telemetry.flush()

    print("Person detection filtering phase complete.")

if __name__ == "__main__":
    main()