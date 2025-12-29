import React, { useEffect, useMemo, useState } from "react";
import {
  Spin,
  Alert,
  Empty,
  Form,
  Input,
  Button,
  message,
  Table,
  Modal,
  Switch,
  Space,
  Tag,
  Tooltip,
  Descriptions,
  Dropdown,
} from "antd";
import { MoreOutlined } from "@ant-design/icons";
import { getDevices, updateDevice, deleteDevice, sendOta, wsUrl as WS_URL } from "../api";

const Devices = () => {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterOffline, setFilterOffline] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editRecord, setEditRecord] = useState(null);
  const [editForm] = Form.useForm();
  const [pendingConfig, setPendingConfig] = useState({}); // sensor_id -> { command_id, started_at }
  const [pendingHealth, setPendingHealth] = useState({}); // sensor_id -> { command_id, started_at }
  const [configOpen, setConfigOpen] = useState(false);
  const [configRecord, setConfigRecord] = useState(null);
  const [healthOpen, setHealthOpen] = useState(false);
  const [healthRecord, setHealthRecord] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        setDevices(await getDevices());
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Auto-refresh devices list (keeps online/offline + latest_configuration up-to-date even if WS is missed)
  useEffect(() => {
    let stopped = false;
    const interval = setInterval(async () => {
      if (stopped) return;
      try {
        setDevices(await getDevices());
      } catch {
        // ignore background refresh errors
      }
    }, 10000);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, []);

  // Timeout cleanup for pending "Get Configuration" requests
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setPendingConfig((prev) => {
        const next = { ...prev };
        for (const [sid, info] of Object.entries(next)) {
          const started = info?.started_at ? Number(info.started_at) : 0;
          if (started && now - started > 30000) {
            delete next[sid];
          }
        }
        return next;
      });
      setPendingHealth((prev) => {
        const next = { ...prev };
        for (const [sid, info] of Object.entries(next)) {
          const started = info?.started_at ? Number(info.started_at) : 0;
          if (started && now - started > 30000) {
            delete next[sid];
          }
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let ws;
    try {
      ws = new WebSocket(WS_URL);
      const token = localStorage.getItem("basic_token");
      if (token) {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "register", sensor_id: `admin-${Date.now()}` }));
        };
      }
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "config" && msg.sensor_id) {
            const cfgPayload = msg.payload || {};
            const nextLatestConfiguration = {
              command_id: msg.command_id || cfgPayload.command_id,
              status: cfgPayload.status || "unknown",
              received_at: msg.timestamp || new Date().toISOString(),
              device_time: cfgPayload.time,
              config: cfgPayload.config,
              error: cfgPayload.error,
            };
            setDevices((prev) =>
              prev.map((d) => {
                const sid = d.sensor_id || d.device_id;
                if (sid !== msg.sensor_id) return d;
                return { ...d, latest_configuration: nextLatestConfiguration };
              }),
            );
            // If modal is open for this device, refresh its content too.
            setConfigRecord((prev) => {
              const sid = prev?.sensor_id || prev?.device_id;
              if (!sid || sid !== msg.sensor_id) return prev;
              return { ...(prev || {}), latest_configuration: nextLatestConfiguration };
            });
            setPendingConfig((prev) => {
              const next = { ...prev };
              // Stop loader as soon as we get a config response for that sensor.
              // If command_id matches, great; if not, still stop (device responded).
              if (next[msg.sensor_id]) delete next[msg.sensor_id];
              // Also clear by command_id (extra-safe if sensor_id mapping differs)
              if (msg.command_id) {
                for (const [sid, info] of Object.entries(next)) {
                  if (info?.command_id && info.command_id === msg.command_id) delete next[sid];
                }
              }
              return next;
            });
          }
          if (msg.type === "health" && msg.sensor_id) {
            const healthPayload = msg.payload || {};
            const nextLatestHealth = {
              command_id: msg.command_id || healthPayload.command_id,
              status: healthPayload.status || "unknown",
              received_at: msg.timestamp || new Date().toISOString(),
              device_time: healthPayload.time,
              health: healthPayload,
              error: healthPayload.error,
            };
            setDevices((prev) =>
              prev.map((d) => {
                const sid = d.sensor_id || d.device_id;
                if (sid !== msg.sensor_id) return d;
                return { ...d, latest_health: nextLatestHealth };
              }),
            );
            // If health modal is open for this device, refresh its content too.
            setHealthRecord((prev) => {
              const sid = prev?.sensor_id || prev?.device_id;
              if (!sid || sid !== msg.sensor_id) return prev;
              return { ...(prev || {}), latest_health: nextLatestHealth };
            });
            setPendingHealth((prev) => {
              const next = { ...prev };
              if (next[msg.sensor_id]) delete next[msg.sensor_id];
              if (msg.command_id) {
                for (const [sid, info] of Object.entries(next)) {
                  if (info?.command_id && info.command_id === msg.command_id) delete next[sid];
                }
              }
              return next;
            });
          }
          if (msg.type === "device_status" && msg.sensor_id) {
            const dev = msg.device || {};
            setDevices((prev) => {
              const sid = msg.sensor_id;
              const idx = prev.findIndex((d) => (d.sensor_id || d.device_id) === sid);
              if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = { ...updated[idx], ...dev, online: msg.online };
                return updated;
              }
              return [...prev, { ...dev, sensor_id: sid, online: msg.online }];
            });
          }
        } catch (e) {
          // ignore
        }
      };
    } catch (e) {
      // ignore ws errors
    }
    return () => {
      if (ws) ws.close();
    };
  }, []);

  const onEdit = async () => {
    try {
      const values = await editForm.validateFields();
      await updateDevice(values);
      message.success("Device updated");
      setEditOpen(false);
      setDevices(await getDevices());
    } catch (err) {
      if (err?.message) setError(err.message);
    }
  };

  const onGetConfig = async (record) => {
    try {
      const sid = record.sensor_id || record.device_id;
      if (!sid) return;
      // Set pending immediately to avoid race where WS response arrives before /send-command returns.
      setPendingConfig((prev) => ({ ...prev, [sid]: { command_id: prev?.[sid]?.command_id, started_at: Date.now() } }));
      const res = await sendOta({ command: "get_configuration", targets: { device_ids: [sid] } });
      if (res?.command_id) {
        setPendingConfig((prev) => {
          if (!prev[sid]) return prev; // already cleared by WS response
          return { ...prev, [sid]: { ...(prev[sid] || {}), command_id: res.command_id } };
        });
      }
      message.success("Get configuration command sent");
    } catch (err) {
      setError(err.message);
    }
  };

  const onHealthCheck = async (record) => {
    try {
      const sid = record.sensor_id || record.device_id;
      if (!sid) return;
      // Set pending immediately to avoid race where WS response arrives before /send-command returns.
      setPendingHealth((prev) => ({ ...prev, [sid]: { command_id: prev?.[sid]?.command_id, started_at: Date.now() } }));
      const res = await sendOta({ command: "health_check", targets: { device_ids: [sid] } });
      if (res?.command_id) {
        setPendingHealth((prev) => {
          if (!prev[sid]) return prev; // already cleared by WS response
          return { ...prev, [sid]: { ...(prev[sid] || {}), command_id: res.command_id } };
        });
      }
      message.success("Health check command sent");
    } catch (err) {
      setError(err.message);
    }
  };

  const onToggleShowConfig = (record) => {
    setConfigRecord(record);
    setConfigOpen(true);
  };

  const onShowHealth = (record) => {
    setHealthRecord(record);
    setHealthOpen(true);
  };

  const onDelete = async (record) => {
    try {
      await deleteDevice({ sensor_id: record.sensor_id, device_id: record.device_id });
      message.success("Device deleted");
      setDevices(await getDevices());
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) return <Spin />;
  if (error) return <Alert type="error" message={error} />;
  const filtered = filterOffline ? devices.filter((d) => d.online === false) : devices;
  const configStatusColor = (s) => (s === "success" ? "green" : s === "failed" ? "red" : "default");
  const healthStatusColor = (s) => (s === "success" ? "green" : s === "failed" ? "red" : "default");
  const formatIST = (iso) => {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(d);
    } catch {
      return String(iso);
    }
  };
  const ageSeconds = (iso) => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return null;
    return Math.max(0, Math.floor((Date.now() - t) / 1000));
  };
  const ageShort = (seconds) => {
    if (typeof seconds !== "number") return "—";
    if (seconds < 60) return `${seconds}s ago`;
    const mins = Math.floor(seconds / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };
  const cpuTempColor = (t) => {
    if (typeof t !== "number") return "default";
    if (t >= 80) return "red";
    if (t >= 70) return "orange";
    if (t >= 60) return "gold";
    return "green";
  };

  const columns = [
    { title: "Sensor ID", dataIndex: "sensor_id", key: "sensor_id", ellipsis: true },
    { title: "Client Name", dataIndex: "client_name", key: "client_name", ellipsis: true },
    { title: "Device Name", dataIndex: "device_name", key: "device_name", ellipsis: true },
    {
      title: "Status",
      dataIndex: "online",
      key: "online",
      render: (val) => <Tag color={val ? "green" : "red"}>{val ? "Online" : "Offline"}</Tag>,
    },
    {
      title: "Latest Config",
      key: "latest_config",
      render: (_, record) => {
        const lc = record.latest_configuration;
        if (!lc) return <span style={{ color: "#999" }}>—</span>;
        const age = ageSeconds(lc.received_at);
        return (
          <div>
            <Tag color={configStatusColor(lc.status)}>{lc.status || "unknown"}</Tag>
            <Tooltip
              title={
                lc.received_at
                  ? `Last Seen (server, IST): ${formatIST(lc.received_at)} IST`
                  : "Last Seen (server, IST): —"
              }
            >
              <div style={{ color: "#666", fontSize: 10, lineHeight: 1.2, marginTop: 4 }}>
                Updated: {ageShort(age)}
              </div>
            </Tooltip>
          </div>
        );
      },
    },
    {
      title: "Latest Health",
      key: "latest_health",
      render: (_, record) => {
        const lh = record.latest_health;
        if (!lh) return <span style={{ color: "#999" }}>—</span>;
        const hp = lh.health || {};
        const cameraOk = hp.camera_reachable;
        const temp = hp.cpu_temp_c;
        const age = ageSeconds(lh.received_at);
        return (
          <div>
            <Space size={6} wrap>
              <Tag color={healthStatusColor(lh.status)}>{lh.status || "unknown"}</Tag>
              {typeof temp === "number" ? <Tag color={cpuTempColor(temp)}>CPU {temp.toFixed(1)}°C</Tag> : <Tag>CPU —</Tag>}
              <Tag color={cameraOk ? "green" : "red"}>Camera {cameraOk ? "OK" : "Down"}</Tag>
            </Space>
            <Tooltip
              title={
                lh.received_at
                  ? `Last Seen (server, IST): ${formatIST(lh.received_at)} IST`
                  : "Last Seen (server, IST): —"
              }
            >
              <div style={{ color: "#666", fontSize: 10, lineHeight: 1.2, marginTop: 4 }}>
                Updated: {ageShort(age)}
              </div>
            </Tooltip>
          </div>
        );
      },
    },
    {
      title: "Actions",
      key: "actions",
      align: "center",
      render: (_, record) => {
        const sid = record.sensor_id || record.device_id;
        return (
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                {
                  key: "get_config",
                  label: "Get Configuration",
                  disabled: !sid,
                  onClick: () => onGetConfig(record),
                },
                {
                  key: "health_check",
                  label: "Health Check",
                  disabled: !sid,
                  onClick: () => onHealthCheck(record),
                },
                { type: "divider" },
                {
                  key: "show_config",
                  label: "Show Configuration",
                  disabled: !record.latest_configuration?.config,
                  onClick: () => onToggleShowConfig(record),
                },
                {
                  key: "show_health",
                  label: "Show Health",
                  disabled: !record.latest_health?.health,
                  onClick: () => onShowHealth(record),
                },
                { type: "divider" },
                {
                  key: "edit",
                  label: "Edit",
                  onClick: () => {
                    setEditRecord(record);
                    editForm.setFieldsValue({
                      sensor_id: record.sensor_id,
                      client_name: record.client_name,
                      device_name: record.device_name,
                    });
                    setEditOpen(true);
                  },
                },
                {
                  key: "delete",
                  label: <span style={{ color: "#cf1322" }}>Delete</span>,
                  onClick: () => {
                    Modal.confirm({
                      title: "Delete device?",
                      content: `Delete ${record.sensor_id || record.device_id || "device"}?`,
                      okText: "Delete",
                      okButtonProps: { danger: true },
                      onOk: () => onDelete(record),
                    });
                  },
                },
              ],
            }}
          >
            <Button
              size="small"
              icon={<MoreOutlined />}
              loading={!!pendingConfig[sid] || !!pendingHealth[sid]}
            />
          </Dropdown>
        );
      },
    },
  ];

  if (!filtered.length)
    return (
      <>
        <div style={{ marginBottom: 12 }}>
          <Switch checked={filterOffline} onChange={setFilterOffline} />{" "}
          <span style={{ marginLeft: 8 }}>Show offline only</span>
        </div>
        <Empty description="No devices registered" />
      </>
    );

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <Switch checked={filterOffline} onChange={setFilterOffline} />{" "}
        <span style={{ marginLeft: 8 }}>Show offline only</span>
      </div>
      <Table
        rowKey={(r) => r.sensor_id || r.device_id}
        columns={columns}
        dataSource={filtered}
        pagination={{ pageSize: 10 }}
        size="small"
        tableLayout="fixed"
      />
      <Modal
        title={`Configuration: ${configRecord?.sensor_id || configRecord?.device_id || ""}`}
        open={configOpen}
        onCancel={() => setConfigOpen(false)}
        footer={[
          <Button key="close" onClick={() => setConfigOpen(false)}>
            Close
          </Button>,
        ]}
        width={900}
        style={{ maxWidth: "90vw" }}
      >
        {(() => {
          const cfg = configRecord?.latest_configuration?.config;
          const err = configRecord?.latest_configuration?.error;
          if (!configRecord) return null;
          return (
            <div>
              {err ? <Alert type="error" message={err} style={{ marginBottom: 8 }} /> : null}
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", maxHeight: "70vh", overflow: "auto" }}>
                {cfg ? JSON.stringify(cfg, null, 2) : "No configuration received yet."}
              </pre>
            </div>
          );
        })()}
      </Modal>
      <Modal
        title={`Health: ${healthRecord?.sensor_id || healthRecord?.device_id || ""}`}
        open={healthOpen}
        onCancel={() => setHealthOpen(false)}
        footer={[
          <Button key="close" onClick={() => setHealthOpen(false)}>
            Close
          </Button>,
        ]}
        width={900}
        style={{ maxWidth: "90vw" }}
      >
        {(() => {
          if (!healthRecord) return null;
          const lh = healthRecord.latest_health;
          const hp = lh?.health || {};
          const load = hp.load_avg || {};
          return (
            <div>
              {lh?.error ? <Alert type="error" message={lh.error} style={{ marginBottom: 8 }} /> : null}
              <Descriptions bordered size="small" column={1} style={{ marginBottom: 12 }}>
                <Descriptions.Item label="Status">{lh?.status || "unknown"}</Descriptions.Item>
                <Descriptions.Item label="Received (server, IST)">{lh?.received_at ? `${formatIST(lh.received_at)} IST` : "—"}</Descriptions.Item>
                <Descriptions.Item label="Device time">{lh?.device_time || hp.time || "—"}</Descriptions.Item>
                <Descriptions.Item label="CPU temp (°C)">{typeof hp.cpu_temp_c === "number" ? hp.cpu_temp_c.toFixed(1) : "—"}</Descriptions.Item>
                <Descriptions.Item label="Load avg (1/5/15)">{`${load["1m"] ?? "—"} / ${load["5m"] ?? "—"} / ${load["15m"] ?? "—"}`}</Descriptions.Item>
                <Descriptions.Item label="Camera">{hp.camera_ip ? `${hp.camera_ip} (${hp.camera_reachable ? "reachable" : "not reachable"})` : "—"}</Descriptions.Item>
              </Descriptions>
              <div style={{ color: "#666", fontSize: 12, marginBottom: 6 }}>Raw payload</div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", maxHeight: "60vh", overflow: "auto" }}>
                {lh?.health ? JSON.stringify(lh.health, null, 2) : "No health received yet."}
              </pre>
            </div>
          );
        })()}
      </Modal>
      <Modal
        title={`Edit ${editRecord?.sensor_id || ""}`}
        open={editOpen}
        onOk={onEdit}
        onCancel={() => setEditOpen(false)}
        okText="Update"
      >
        <Form layout="vertical" form={editForm}>
          <Form.Item name="sensor_id" label="Sensor ID">
            <Input disabled />
          </Form.Item>
          <Form.Item name="client_name" label="Client Name">
            <Input />
          </Form.Item>
          <Form.Item name="device_name" label="Device Name">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
};

export default Devices;
