// Layer 1, ingest: the UDP socket the game sends to (port 20777). Each
// datagram is handed on raw (for recording) and parsed (for the pipeline).
const dgram = require('dgram');
const { parsePacket } = require('./parsePacket');

function startUdpListener({ port = 20777, host = '127.0.0.1', onPacket, onRawPacket }) {
  const socket = dgram.createSocket('udp4');

  socket.on('message', (msg) => {
    if (onRawPacket) onRawPacket(msg);

    let parsed;
    try {
      parsed = parsePacket(msg);
    } catch (err) {
      console.warn('[udp] failed to parse packet, dropping:', err.message);
      return;
    }

    if (parsed.data === null) return;
    // A state-handler bug on one odd packet must cost that packet, not the
    // whole bridge mid-race (replay already guards the same call).
    try {
      onPacket(parsed.header.packetId, parsed.header, parsed.data);
    } catch (err) {
      console.warn(`[udp] failed to apply packet ${parsed.header.packetId}, dropping:`, err.message);
    }
  });

  socket.on('error', (err) => {
    console.error('[udp] socket error:', err);
  });

  socket.bind(port, host, () => {
    console.log(`[udp] listening for F1 telemetry on ${host}:${port}`);
  });

  return socket;
}

module.exports = { startUdpListener };
