import argparse
import io
from pathlib import Path

from PIL import Image

import vw_telemetry as telemetry

DEFAULT_SCALE = 4
DEFAULT_MODEL = "4xNomos8k_atd"
PILLOW_MODEL = "pillow-lanczos"
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
NOMOS_MODEL_PATH = PROJECT_ROOT / "models" / f"{DEFAULT_MODEL}.safetensors"
_SPANDREL_CACHE = {}


def _load_spandrel_model(model_path=NOMOS_MODEL_PATH):
    cache_key = str(model_path)
    if cache_key in _SPANDREL_CACHE:
        return _SPANDREL_CACHE[cache_key]

    import torch
    from spandrel import ModelLoader

    descriptor = ModelLoader().load_from_file(model_path)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    descriptor = descriptor.to(device).eval()
    _SPANDREL_CACHE[cache_key] = descriptor
    return descriptor


def _pil_to_tensor(image):
    import numpy as np
    import torch

    arr = np.asarray(image).astype("float32") / 255.0
    tensor = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0)
    return tensor


def _tensor_to_pil(tensor):
    import numpy as np

    tensor = tensor.detach().float().cpu().clamp(0, 1).squeeze(0)
    arr = (tensor.permute(1, 2, 0).numpy() * 255.0).round().astype(np.uint8)
    return Image.fromarray(arr)


def _upscale_with_spandrel(image, model_path=NOMOS_MODEL_PATH):
    import torch

    descriptor = _load_spandrel_model(model_path)
    width, height = image.size
    min_size = getattr(getattr(descriptor, "size_requirements", None), "minimum", 1) or 1
    padded_width = max(width, min_size)
    padded_height = max(height, min_size)

    if (padded_width, padded_height) != image.size:
        padded = Image.new("RGB", (padded_width, padded_height))
        padded.paste(image, (0, 0))
        image = padded

    tensor = _pil_to_tensor(image).to(descriptor.device)
    with torch.no_grad():
        result = descriptor(tensor)

    upscaled = _tensor_to_pil(result)
    scale = getattr(descriptor, "scale", DEFAULT_SCALE) or DEFAULT_SCALE
    return upscaled.crop((0, 0, width * scale, height * scale))


def _upscale_with_pillow(image, scale=DEFAULT_SCALE):
    width, height = image.size
    return image.resize((width * scale, height * scale), Image.Resampling.LANCZOS)


def upscale_bytes(content, model=DEFAULT_MODEL, scale=DEFAULT_SCALE):
    with Image.open(io.BytesIO(content)) as image:
        original_format = image.format or "PNG"
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")

        use_model = model == DEFAULT_MODEL and NOMOS_MODEL_PATH.exists()

        # The Lanczos path is a plain resize, not a model, so it is not recorded
        # as one -- that would put non-model work in the model table and quietly
        # inflate every volume figure. But falling back because the weights are
        # missing is exactly the kind of silent degradation telemetry exists to
        # surface, so it is recorded as `rejected` (a policy outcome, the same
        # shape as a budget refusal) rather than as a successful upscale.
        if not use_model:
            telemetry.record(
                provider="local", runtime="pillow", model=PILLOW_MODEL, task="image",
                service="dataset-builder-upscale", status="rejected",
                error_class="UpscalerModelMissing" if model == DEFAULT_MODEL else "UpscalerNotRequested",
                error_message=f"{NOMOS_MODEL_PATH} not present" if model == DEFAULT_MODEL else None,
                width=image.width, height=image.height, image_count=1,
                duration_ms=0.0,
            )
            resized = _upscale_with_pillow(image, scale=scale)
        else:
            with telemetry.run(
                model=DEFAULT_MODEL,
                task="image",
                runtime="spandrel",
                service="dataset-builder-upscale",
                width=image.width,
                height=image.height,
                image_count=1,
                input_bytes=len(content),
            ) as run:
                resized = _upscale_with_spandrel(image.convert("RGB"), NOMOS_MODEL_PATH)
                run.set(output_width=resized.width, output_height=resized.height)

        out = io.BytesIO()
        save_format = "JPEG" if original_format.upper() in {"JPG", "JPEG"} else original_format
        save_kwargs = {}
        if save_format == "JPEG":
            save_kwargs.update({"quality": 95, "optimize": True})
            if resized.mode == "RGBA":
                resized = resized.convert("RGB")

        resized.save(out, format=save_format, **save_kwargs)
        return out.getvalue()


def upscale_file(input_path, output_path=None, model=DEFAULT_MODEL, scale=DEFAULT_SCALE):
    src = Path(input_path)
    if output_path:
        dest = Path(output_path)
    else:
        dest = src.with_name(f"{src.stem}_upscaled{src.suffix}")

    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(upscale_bytes(src.read_bytes(), model=model, scale=scale))
    return dest


def main():
    parser = argparse.ArgumentParser(description="Upscale an image locally with Pillow.")
    parser.add_argument("input", help="Input image path")
    parser.add_argument("-o", "--output", default="", help="Output image path")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Upscale model name")
    parser.add_argument("--scale", type=int, default=DEFAULT_SCALE, help="Upscale factor")
    args = parser.parse_args()

    output = upscale_file(args.input, args.output or None, model=args.model, scale=args.scale)
    print(f"Upscaled image written to {output}")


if __name__ == "__main__":
    main()
