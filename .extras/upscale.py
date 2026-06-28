import os
import argparse
from pathlib import Path
from PIL import Image
import torch
import torchvision.transforms.functional as TF
from spandrel import ModelLoader, ImageModelDescriptor
from tqdm import tqdm

def tile_process(model, in_tensor, tile_size=512, tile_pad=32):
    """
    Executes a seamless feathering/blending tile pipeline.
    Accumulates overlapping predictions and normalizes via an explicit weight canvas.
    """
    device = in_tensor.device
    _, channels, H, W = in_tensor.shape
    scale = model.scale
    
    out_H, out_W = H * scale, W * scale
    out_tensor = torch.zeros((1, channels, out_H, out_W), device=device, dtype=torch.float32)
    weight_canvas = torch.zeros((1, 1, out_H, out_W), device=device, dtype=torch.float32)

    cols = range(0, W, tile_size)
    rows = range(0, H, tile_size)
    total_tiles = len(rows) * len(cols)

    with tqdm(total=total_tiles, desc=" -> Tiles", leave=False, unit="tile") as pbar:
        for y in rows:
            for x in cols:
                # Coordinate extraction including context padding bounds
                y0 = max(0, y - tile_pad)
                y1 = min(H, y + tile_size + tile_pad)
                x0 = max(0, x - tile_pad)
                x1 = min(W, x + tile_size + tile_pad)

                tile = in_tensor[:, :, y0:y1, x0:x1]

                with torch.inference_mode():
                    out_tile = model(tile)

                h_tile, w_tile = out_tile.shape[2], out_tile.shape[3]
                
                # Compute actual padding depth on each edge (handles canvas borders)
                pad_top = (y - y0) * scale
                pad_bottom = (y1 - min(H, y + tile_size)) * scale
                pad_left = (x - x0) * scale
                pad_right = (x1 - min(W, x + tile_size)) * scale

                # Build 1D linear ramp interpolations for alpha feathering
                ramp_y = torch.ones(h_tile, device=device, dtype=torch.float32)
                if pad_top > 0:
                    ramp_y[:pad_top] = torch.linspace(0, 1, pad_top, device=device)
                if pad_bottom > 0:
                    ramp_y[-pad_bottom:] = torch.linspace(1, 0, pad_bottom, device=device)

                ramp_x = torch.ones(w_tile, device=device, dtype=torch.float32)
                if pad_left > 0:
                    ramp_x[:pad_left] = torch.linspace(0, 1, pad_left, device=device)
                if pad_right > 0:
                    ramp_x[-pad_right:] = torch.linspace(1, 0, pad_right, device=device)

                # Compute 2D blending weight matrix footprint via outer product
                tile_mask = torch.outer(ramp_y, ramp_x).unsqueeze(0).unsqueeze(0)

                # Map patch dimensions onto destination global canvas coordinates
                out_y0, out_y1 = y0 * scale, y1 * scale
                out_x0, out_x1 = x0 * scale, x1 * scale

                out_tensor[:, :, out_y0:out_y1, out_x0:out_x1] += out_tile * tile_mask
                weight_canvas[:, :, out_y0:out_y1, out_x0:out_x1] += tile_mask
                
                del tile, out_tile, tile_mask
                pbar.update(1)

    # Perform element-wise division to normalize blending regions
    out_tensor /= torch.clamp(weight_canvas, min=1e-5)
    return out_tensor

def main():
    parser = argparse.ArgumentParser(description="Inference script for ATD model execution via Spandrel.")
    parser.add_argument("--input_dir", type=str, required=True)
    parser.add_argument("--model_path", type=str, required=True)
    args = parser.parse_args()

    input_path = Path(args.input_dir)
    output_path = input_path / ".completed"
    output_path.mkdir(exist_ok=True)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    
    model = ModelLoader().load_from_file(args.model_path)
    if not isinstance(model, ImageModelDescriptor):
        raise TypeError("The loaded model architecture is incompatible with image-to-image tasks.")
    
    model = model.to(device).eval()

    valid_exts = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
    files = [f for f in input_path.iterdir() if f.is_file() and f.suffix.lower() in valid_exts]

    if not files:
        print("No target source images isolated inside the path directory.")
        return

    for file in tqdm(files, desc="Upscaling Pipeline", unit="img"):
        try:
            img = Image.open(file).convert("RGB")
            in_tensor = TF.to_tensor(img).unsqueeze(0).to(device)

            out_tensor = tile_process(model, in_tensor, tile_size=512, tile_pad=32)

            out_tensor = out_tensor.squeeze(0).clamp(0, 1)
            out_img = TF.to_pil_image(out_tensor.cpu())

            out_file = output_path / f"upscaled_{file.name}"
            out_img.save(out_file)
            
            del in_tensor, out_tensor
            torch.cuda.empty_cache()
            
        except Exception as e:
            print(f"\nExecution failure parsing target file: {file.name} | Error: {e}")

if __name__ == "__main__":
    main()