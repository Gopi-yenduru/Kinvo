# CPU image. For GPU, switch the base to an NVIDIA CUDA runtime (e.g.
# nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04 + python) and install CUDA torch wheels,
# then run the container with `--gpus all`.
FROM python:3.12-slim

WORKDIR /app

# libsndfile for soundfile (WAV I/O); ffmpeg for some ASR pipelines; git for the parler-tts VCS dep.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 ffmpeg git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8005
CMD ["python", "main.py"]
