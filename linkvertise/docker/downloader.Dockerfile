FROM python:3.13-slim

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
RUN python -m playwright install --with-deps chromium
COPY src /app/src
ENV PYTHONPATH=/app/src
CMD ["python", "-m", "linkvertise_downloader.cli", "--help"]
