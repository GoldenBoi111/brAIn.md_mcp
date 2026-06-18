FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    EMBEDDER_HOST=0.0.0.0 \
    EMBEDDER_PORT=8001 \
    JASPER_MODEL_NAME=infgrad/Jasper-Token-Compression-600M

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential gcc \
    && rm -rf /var/lib/apt/lists/*

COPY services/jasper-embedder/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
    && pip install --no-cache-dir -r /app/requirements.txt

COPY services/jasper-embedder/app.py /app/app.py

EXPOSE 8001

CMD ["python", "/app/app.py"]
