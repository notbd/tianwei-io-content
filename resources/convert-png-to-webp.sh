# ==========================================================
# convert_png_to_webp.sh
# Batch convert PNG/PNG images to WebP using ffmpeg
# - preserves quality near-lossless
# - skips if output .webp or .WEBP already exists
# ==========================================================

# --- Adjustable Settings ---
QUALITY=88              # 0–100 (higher = better)
COMPRESSION_LEVEL=6      # 0–6 typical, up to 9–10 (slower)
PRESET="picture"         # presets: default, photo, picture, drawing, icon, text
ALPHA_QUALITY=100        # transparency fidelity (100 = best)

# --- Script Logic ---
shopt -s nullglob nocaseglob  # case-insensitive matching for .png / .PNG

for f in *.png; do
  base="${f%.*}"

  # Skip if WebP already exists (any case)
  if [[ -f "${base}.webp" || -f "${base}.WEBP" ]]; then
    echo "⏭️  Skipping '$f' (WebP already exists)"
    continue
  fi

  echo "⚙️  Converting '$f' → '${base}.webp'..."
  ffmpeg -hide_banner -loglevel error \
    -i "$f" \
    -c:v libwebp -preset "$PRESET" \
    -q:v "$QUALITY" -compression_level "$COMPRESSION_LEVEL" \
    -alpha_quality "$ALPHA_QUALITY" \
    -map_metadata -1 \
    "${base}.webp"

  if [[ $? -eq 0 ]]; then
    echo "✅  Success: ${base}.webp"
  else
    echo "❌  Failed: $f"
  fi
done
