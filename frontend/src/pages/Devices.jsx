import React, { useEffect, useMemo, useState } from "react";
import { Spin, Alert, Empty, Form, Input, Button, message, Table, Modal, Popconfirm, Switch, Space, Tag, Tooltip } from "antd";
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
  const [configOpen, setConfigOpen] = useState(false);
  const [configRecord, setConfigRecord] = useState(null);

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
      const res = await sendOta({ command: "get_configuration", targets: { device_ids: [sid] } });
      if (res?.command_id) {
        setPendingConfig((prev) => ({ ...prev, [sid]: { command_id: res.command_id, started_at: Date.now() } }));
      }
      message.success("Get configuration command sent");
    } catch (err) {
      setError(err.message);
    }
  };

  const onToggleShowConfig = (record) => {
    setConfigRecord(record);
    setConfigOpen(true);
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

  const columns = [
    { title: "Sensor ID", dataIndex: "sensor_id", key: "sensor_id" },
    { title: "Client Name", dataIndex: "client_name", key: "client_name" },
    { title: "Device Name", dataIndex: "device_name", key: "device_name" },
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
        return (
          <div>
            <Tag color={configStatusColor(lc.status)}>{lc.status || "unknown"}</Tag>
            <div style={{ color: "#666", fontSize: 12 }}>
              <Tooltip
                title={
                  lc.device_time
                    ? `device-reported time: ${formatIST(lc.device_time)} IST (raw: ${lc.device_time})`
                    : "device-reported time: —"
                }
              >
                <span>
                  {lc.received_at ? `received (server): ${formatIST(lc.received_at)} IST` : "received (server): —"}
                </span>
              </Tooltip>
            </div>
          </div>
        );
      },
    },
    {
      title: "Actions",
      key: "actions",
      render: (_, record) => (
        <Space>
          <Tooltip title="Ask device to send its current configuration via WebSocket">
            <Button
              size="small"
              loading={!!pendingConfig[record.sensor_id || record.device_id]}
              onClick={() => onGetConfig(record)}
            >
              Get Configuration
            </Button>
          </Tooltip>
          <Button size="small" disabled={!record.latest_configuration?.config} onClick={() => onToggleShowConfig(record)}>
            Show Configuration
          </Button>
          <Button
            size="small"
            onClick={() => {
              setEditRecord(record);
              editForm.setFieldsValue({
                sensor_id: record.sensor_id,
                client_name: record.client_name,
                device_name: record.device_name,
              });
              setEditOpen(true);
            }}
          >
            Edit
          </Button>
          <Popconfirm title="Delete device?" onConfirm={() => onDelete(record)}>
            <Button size="small" danger>
              Delete
            </Button>
          </Popconfirm>
        </Space>
      ),
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
        width={800}
      >
        {(() => {
          const cfg = configRecord?.latest_configuration?.config;
          const err = configRecord?.latest_configuration?.error;
          if (!configRecord) return null;
          return (
            <div>
              {err ? <Alert type="error" message={err} style={{ marginBottom: 8 }} /> : null}
              <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                {cfg ? JSON.stringify(cfg, null, 2) : "No configuration received yet."}
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
