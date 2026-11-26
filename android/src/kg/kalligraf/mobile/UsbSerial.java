package kg.kalligraf.mobile;

import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Последовательный порт через USB-OTG без сторонних библиотек.
 * Поддержка: CH340/CH341 (плата GUANGKU) и платы CDC-ACM (Arduino с родным USB).
 */
final class UsbSerial {
    interface Listener {
        void onData(byte[] data, int len);
    }

    static final int VID_WCH = 0x1A86; // CH340 / CH341

    private UsbDeviceConnection conn;
    private UsbEndpoint in, out;
    private final List<UsbInterface> claimed = new ArrayList<>();
    private volatile boolean running;
    private Thread reader;
    final UsbDevice device;

    private UsbSerial(UsbDevice d) { device = d; }

    static boolean supported(UsbDevice d) {
        if (d.getVendorId() == VID_WCH) return true;
        for (int i = 0; i < d.getInterfaceCount(); i++) {
            if (d.getInterface(i).getInterfaceClass() == UsbConstants.USB_CLASS_CDC_DATA) return true;
        }
        return false;
    }

    static UsbSerial open(UsbManager m, UsbDevice d, int baud, Listener l) throws IOException {
        UsbSerial s = new UsbSerial(d);
        s.conn = m.openDevice(d);
        if (s.conn == null) throw new IOException("Не удалось открыть USB-устройство");
        try {
            if (d.getVendorId() == VID_WCH) s.initCh340(baud);
            else s.initCdc(baud);
        } catch (IOException e) {
            s.close();
            throw e;
        }
        s.start(l);
        return s;
    }

    // ── CH340 ───────────────────────────────────────────────────────────

    private void initCh340(int baud) throws IOException {
        UsbInterface intf = device.getInterface(0);
        claim(intf);
        findBulk(intf);
        controlIn(0x5F, 0, 0, 2);          // версия чипа
        controlOut(0xA1, 0, 0);            // сброс
        setBaudCh340(baud);
        controlIn(0x95, 0x2518, 0, 2);
        controlOut(0x9A, 0x2518, 0x0050);  // 8 бит, без чётности, 1 стоп
        controlIn(0x95, 0x0706, 0, 2);
        controlOut(0xA1, 0x501F, 0xD90A);
        setBaudCh340(baud);
        controlOut(0xA4, ~(0x20 | 0x40), 0); // DTR и RTS включены
    }

    private void setBaudCh340(int baud) throws IOException {
        long factor = 1532620800L / baud;
        int divisor = 3;
        while (factor > 0xFFF0 && divisor > 0) {
            factor >>= 3;
            divisor--;
        }
        factor = 0x10000 - factor;
        divisor |= 0x0080;
        int val1 = (int) ((factor & 0xFF00) | divisor);
        int val2 = (int) (factor & 0xFF);
        controlOut(0x9A, 0x1312, val1);
        controlOut(0x9A, 0x0F2C, val2);
    }

    // ── CDC-ACM ─────────────────────────────────────────────────────────

    private void initCdc(int baud) throws IOException {
        UsbInterface control = null, data = null;
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            UsbInterface f = device.getInterface(i);
            if (f.getInterfaceClass() == UsbConstants.USB_CLASS_COMM && control == null) control = f;
            if (f.getInterfaceClass() == UsbConstants.USB_CLASS_CDC_DATA && data == null) data = f;
        }
        if (data == null) throw new IOException("Устройство не похоже на последовательный порт");
        if (control != null) claim(control);
        claim(data);
        findBulk(data);
        int idx = control != null ? control.getId() : 0;
        byte[] coding = {
                (byte) (baud & 0xFF), (byte) ((baud >> 8) & 0xFF), (byte) ((baud >> 16) & 0xFF), (byte) ((baud >> 24) & 0xFF),
                0, 0, 8 };
        if (conn.controlTransfer(0x21, 0x20, 0, idx, coding, coding.length, 1000) < 0)
            throw new IOException("Не удалось задать скорость порта");
        conn.controlTransfer(0x21, 0x22, 0x03, idx, null, 0, 1000); // DTR + RTS
    }

    // ── общее ───────────────────────────────────────────────────────────

    private void claim(UsbInterface f) throws IOException {
        if (!conn.claimInterface(f, true)) throw new IOException("USB занят другим приложением");
        claimed.add(f);
    }

    private void findBulk(UsbInterface f) throws IOException {
        for (int i = 0; i < f.getEndpointCount(); i++) {
            UsbEndpoint e = f.getEndpoint(i);
            if (e.getType() != UsbConstants.USB_ENDPOINT_XFER_BULK) continue;
            if (e.getDirection() == UsbConstants.USB_DIR_IN) in = e;
            else out = e;
        }
        if (in == null || out == null) throw new IOException("У устройства нет каналов данных");
    }

    private void controlOut(int req, int value, int index) throws IOException {
        if (conn.controlTransfer(0x40, req, value, index, null, 0, 1000) < 0)
            throw new IOException("Плата не отвечает (запрос 0x" + Integer.toHexString(req) + ")");
    }

    private void controlIn(int req, int value, int index, int len) throws IOException {
        byte[] b = new byte[len];
        if (conn.controlTransfer(0xC0, req, value, index, b, len, 1000) < 0)
            throw new IOException("Плата не отвечает (запрос 0x" + Integer.toHexString(req) + ")");
    }

    private void start(final Listener l) {
        running = true;
        reader = new Thread(() -> {
            byte[] buf = new byte[Math.max(64, in.getMaxPacketSize()) * 4];
            while (running) {
                int n = conn.bulkTransfer(in, buf, buf.length, 200);
                if (n > 0) l.onData(buf, n);
            }
        }, "usb-read");
        reader.setDaemon(true);
        reader.start();
    }

    synchronized void write(byte[] data) throws IOException {
        int off = 0;
        while (off < data.length) {
            int n = conn.bulkTransfer(out, data, off, data.length - off, 2000);
            if (n < 0) throw new IOException("Ошибка отправки на машину");
            off += n;
        }
    }

    void close() {
        running = false;
        if (reader != null) {
            try { reader.join(500); } catch (InterruptedException ignored) { }
        }
        if (conn != null) {
            for (UsbInterface f : claimed) conn.releaseInterface(f);
            conn.close();
            conn = null;
        }
        claimed.clear();
    }
}
