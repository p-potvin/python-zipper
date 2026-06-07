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

# Ensure dependencies are installed before we import them
install_dependencies()

# Now safe to import
import torch
from PIL import Image
from transformers import DetrImageProcessor, DetrForObjectDetection

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

    print("Initializing Facebook DETR-ResNet-50 object detection model...")
    try:
        # Load DETR model
        processor = DetrImageProcessor.from_pretrained("facebook/detr-resnet-50")
        model = DetrForObjectDetection.from_pretrained("facebook/detr-resnet-50")
        # Put model in evaluation mode
        model.eval()
    except Exception as e:
        print(f"Failed to load DETR model from Hugging Face: {e}")
        sys.exit(1)

    # Valid image extensions
    valid_extensions = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    
    # Collect all images in directory
    files = [
        os.path.join(args.dir, f) for f in os.listdir(args.dir)
        if os.path.isfile(os.path.join(args.dir, f)) and os.path.splitext(f)[1].lower() in valid_extensions
    ]

    if not files:
        print("No images found to analyze.")
        sys.exit(0)

    print(f"Analyzing {len(files)} images for person presence...")
    
    # Disable gradient computation for faster inference and lower memory usage
    with torch.no_grad():
        for file_path in files:
            # Skip files in the .completed directory itself if scanned
            if os.path.abspath(file_path).startswith(os.path.abspath(args.completed)):
                continue

            try:
                # Open image
                image = Image.open(file_path).convert("RGB")
                
                # Preprocess image
                inputs = processor(images=image, return_tensors="pt")
                
                # Run inference
                outputs = model(**inputs)
                
                # Post-process results
                target_sizes = torch.tensor([image.size[::-1]])
                results = processor.post_process_object_detection(outputs, target_sizes=target_sizes, threshold=args.threshold)[0]
                
                # Count "person" class detections
                person_count = 0
                for label in results["labels"]:
                    label_name = model.config.id2label[label.item()]
                    if label_name == "person":
                        person_count += 1
                        
                print(f"Image '{os.path.basename(file_path)}': detected {person_count} person(s)")
                
                # Keep if exactly one person, move to completed otherwise
                if person_count != 1:
                    move_file_safe(file_path, args.completed)
                    
            except Exception as e:
                print(f"Error processing image {file_path}: {e}")
                # Move corrupted or unreadable images to completed as well
                move_file_safe(file_path, args.completed)

    print("Person detection filtering phase complete.")

if __name__ == "__main__":
    main()
