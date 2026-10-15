FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 APP_MODE=demo CITYTRACE_HOST=0.0.0.0 CITYTRACE_PORT=8000 CITYTRACE_DATA_DIR=/app/data
WORKDIR /app
COPY app.py ./app.py
COPY migrations ./migrations
COPY static ./static
RUN useradd --create-home --uid 10001 citytrace && mkdir -p /app/data && chown -R citytrace:citytrace /app
USER citytrace
EXPOSE 8000
CMD ["python", "app.py", "--host", "0.0.0.0", "--port", "8000"]
