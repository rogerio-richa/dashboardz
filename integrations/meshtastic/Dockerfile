# Python because that is where Meshtastic's maintained library lives — one of the reasons an
# integration is its own process rather than a plugin inside a Node hub.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./
ENV CONFIG_PATH=/data/meshtastic.json
EXPOSE 8600
VOLUME /data
CMD ["python", "-u", "main.py"]
