FROM python:3.12-slim

WORKDIR /app

# Silero VAD (via livekit-plugins-silero / onnxruntime) needs libgomp at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8766
CMD ["python", "main.py"]
