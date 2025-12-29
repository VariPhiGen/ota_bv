import React, { useEffect, useMemo, useState } from "react";
import { Alert, Card, List, Spin, Tag, Form, Input, Button, Select, message, Divider, Switch } from "antd";
import { getOtaHistory, getDevices, sendOta, listUploads } from "../api";
import { wsUrl as WS_URL } from "../api";

const statusColors = {
  pending: "default",
  sent: "blue",
  acked: "green",
  failed: "red",
};

const OTA = () => {
  const [commands, setCommands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [devices, setDevices] = useState([]);
  const [sending, setSending] = useState(false);
  const [uploads, setUploads] = useState({ models: [], configs: [] });

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const [history, devs, up] = await Promise.all([getOtaHistory(), getDevices(), listUploads()]);
        setCommands(history);
        setDevices(devs);
        setUploads(up || { models: [], configs: [] });
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Auto-refresh history periodically in case WS is missed (ACK/config updates still come via WS)
  useEffect(() => {
    let stopped = false;
    const interval = setInterval(async () => {
      if (stopped) return;
      try {
        setCommands(await getOtaHistory());
      } catch {
        // ignore background refresh errors
      }
    }, 15000);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let ws;
    try {
      ws = new WebSocket(WS_URL);
      const token = localStorage.getItem("basic_token");
      if (token) {
        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: "register",
              sensor_id: `admin-${Date.now()}`, // placeholder client id
            }),
          );
        };
      }
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "ack") {
            setCommands((prev) => {
              const updated = [...prev];
              const idx = updated.findIndex((c) => c.command_id === msg.command_id);
              if (idx >= 0) {
                const cur = updated[idx] || {};
                const perDevice = { ...(cur.per_device || {}) };
                if (msg.sensor_id) {
                  perDevice[msg.sensor_id] = { ...(perDevice[msg.sensor_id] || {}), status: "acked", ack: msg };
                }
                const acks = [...(cur.acks || [])];
                acks.push(msg);
                updated[idx] = {
                  ...cur,
                  ack: msg, // latest
                  acks,
                  per_device: perDevice,
                  last_update: msg.timestamp || cur.last_update,
                };
              }
              return updated;
            });
          }
        } catch (e) {
          // ignore malformed messages
        }
      };
    } catch (err) {
      console.error("WS error", err);
    }
    return () => {
      if (ws) ws.close();
    };
  }, []);

  const sorted = useMemo(
    () =>
      [...commands].sort(
        (a, b) => new Date(b.last_update || b.created_at || 0) - new Date(a.last_update || a.created_at || 0),
      ),
    [commands],
  );

  const onSend = async (values) => {
    setError("");
    try {
      setSending(true);
      let payload = {};
      if (values.payload) {
        try {
          payload = JSON.parse(values.payload);
        } catch (e) {
          message.error("Payload must be valid JSON");
          return;
        }
      }
      const targets = values.targets || [];
      if (!targets.length) {
        message.error("Select at least one device");
        return;
      }

      const steps = {};
      if (values.model_key || values.labels_key) {
        steps.model_update = {
          enabled: true,
          model_hef_url: values.model_key || undefined,
          labels_json_url: values.labels_key || undefined,
        };
      }
      if (values.config_key || values.nested_updates) {
        let nested = {};
        if (values.nested_updates) {
          try {
            nested = JSON.parse(values.nested_updates);
          } catch (e) {
            message.error("Nested updates must be valid JSON");
            return;
          }
        }
        steps.config_update = {
          enabled: true,
          mode: values.config_key ? "s3" : "nested",
          config_s3_url: values.config_key || undefined,
          nested_updates: nested,
        };
      }
      if (values.git_enabled) {
        steps.git_update = {
          enabled: true,
          branch: values.git_branch || "main",
          tag: values.git_tag || undefined,
        };
      }
      if (values.shell_enabled) {
        steps.shell_exec = {
          enabled: true,
          script_name: values.shell_script || undefined,
        };
      }
      if (values.restart_service || values.reboot) {
        steps.post_actions = {
          restart_service: !!values.restart_service,
          service_name: values.service_name || undefined,
          reboot: !!values.reboot,
        };
      }
      if (values.rollback_config || values.rollback_model) {
        steps.rollback = {
          config: !!values.rollback_config,
          model: !!values.rollback_model,
        };
      }

      // Auto-build payload if not provided
      if (!values.payload) {
        payload = {
          command: "ota_update",
          targets: { device_ids: targets },
          steps,
        };
      } else {
        payload = {
          command: payload.command || "ota_update",
          ...payload,
          targets: { device_ids: targets },
          steps: { ...(payload.steps || {}), ...steps },
        };
      }

      // Send once; backend fans out to targets.device_ids under one command_id
      await sendOta(payload);

      message.success("OTA command sent");
      setCommands(await getOtaHistory());
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  if (loading) return <Spin />;
  if (error) return <Alert type="error" message={error} />;

  return (
    <Card title="OTA">
      <Card type="inner" title="Send OTA Command" style={{ marginBottom: 16 }}>
        <Form layout="vertical" onFinish={onSend}>
          <Form.Item name="targets" label="Target devices" rules={[{ required: true, message: "Select devices" }]}>
            <Select
              mode="multiple"
              placeholder="Select devices"
              options={devices.map((d) => ({
                value: d.sensor_id || d.device_id,
                label: d.device_name || d.sensor_name || d.sensor_id || d.device_id,
              }))}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Divider>Artifacts</Divider>
          <Form.Item name="model_key" label="Model (.hef)" tooltip="Select from uploaded models (URL)">
            <Select
              allowClear
              placeholder="Select model hef"
              options={(uploads.models || []).map((m) => ({
                value: m.files?.model_download_url || m.files?.model_url || m.files?.model,
                label: m.name || m.files?.model_download_url || m.files?.model_url || m.files?.model,
              }))}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item name="labels_key" label="Labels (labels.json)" tooltip="Select from uploaded labels (URL)">
            <Select
              allowClear
              placeholder="Select labels json"
              options={(uploads.models || []).map((m) => ({
                value: m.files?.labels_download_url || m.files?.labels_url || m.files?.labels,
                label: m.name ? `${m.name} (labels)` : m.files?.labels_download_url || m.files?.labels_url || m.files?.labels,
              }))}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item name="config_key" label="Configuration" tooltip="Select from uploaded configs (URL)">
            <Select
              allowClear
              placeholder="Select config"
              options={(uploads.configs || []).map((c) => ({
                value: c.file_download_url || c.file_url || c.file,
                label: c.name || c.file_download_url || c.file_url || c.file,
              }))}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item
            name="nested_updates"
            label="Nested updates (JSON object)"
            extra='Example: {"camera_details.username":"admin"}'
          >
            <Input.TextArea rows={3} placeholder='{"some.key":"value"}' />
          </Form.Item>
          <Divider>Command</Divider>
          <Divider>Git update</Divider>
          <Form.Item
            name="git_enabled"
            label="Enable git pull"
            valuePropName="checked"
            tooltip="Optional: ask device to update code via git"
          >
            <Switch />
          </Form.Item>
          <Form.Item name="git_branch" label="Git branch" tooltip="Used when git pull is enabled">
            <Input placeholder="main" />
          </Form.Item>
          <Form.Item name="git_tag" label="Git tag (optional)" tooltip="Optional tag checkout after pull">
            <Input placeholder="v1.2.3" />
          </Form.Item>

          <Divider>Shell script</Divider>
          <Form.Item
            name="shell_enabled"
            label="Run shell script"
            valuePropName="checked"
            tooltip="Optional: run a script on the device"
          >
            <Switch />
          </Form.Item>
          <Form.Item name="shell_script" label="Script name/path" tooltip='Example: "scripts/post_update.sh"'>
            <Input placeholder="scripts/post_update.sh" />
          </Form.Item>

          <Divider>Post actions</Divider>
          <Form.Item name="restart_service" label="Restart service" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="service_name" label="Service name" tooltip='Example: "edge_service"'>
            <Input placeholder="edge_service" />
          </Form.Item>
          <Form.Item name="reboot" label="Reboot device" valuePropName="checked">
            <Switch />
          </Form.Item>

          <Divider>Rollback</Divider>
          <Form.Item name="rollback_config" label="Rollback config" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="rollback_model" label="Rollback model" valuePropName="checked">
            <Switch />
          </Form.Item>

          <Form.Item
            name="payload"
            label="Command payload (JSON)"
            extra='Leave empty to auto-build an ota_update command from selections above.'
          >
            <Input.TextArea rows={4} placeholder='{"action":"ota_update","url":"http://..."}' />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={sending}>
              Send
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card type="inner" title="OTA History">
        <List
          itemLayout="horizontal"
          dataSource={sorted}
          renderItem={(item) => (
            <List.Item>
              <List.Item.Meta
                title={
                  <div>
                    <strong>{item.command_id}</strong>{" "}
                    <Tag color={statusColors[item.status] || "default"}>{item.status}</Tag>
                  </div>
                }
                description={
                  <div>
                    {item.targets?.device_ids?.length ? (
                      <div>Targets: {item.targets.device_ids.join(", ")}</div>
                    ) : (
                      <div>Sensor: {item.sensor_id}</div>
                    )}
                    <div>Created: {item.created_at}</div>
                    <div>Updated: {item.last_update}</div>
                    {item.reason && <div>Reason: {item.reason}</div>}
                    {item.ack && (
                      <div style={{ marginTop: 8 }}>
                        <div>
                          <strong>ACK:</strong> {item.ack.status || "unknown"}{" "}
                          {item.ack.timestamp ? `(${item.ack.timestamp})` : ""}
                        </div>
                        <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                          {JSON.stringify(item.ack.payload || item.ack, null, 2)}
                        </pre>
                      </div>
                    )}
                    {item.per_device && item.targets?.device_ids?.length ? (
                      <div style={{ marginTop: 8 }}>
                        <strong>Per-device:</strong>
                        <div style={{ marginTop: 4 }}>
                          {item.targets.device_ids.map((sid) => {
                            const pd = item.per_device?.[sid] || {};
                            return (
                              <div key={sid}>
                                {sid}: {pd.status || "unknown"} {pd.reason ? `(${pd.reason})` : ""}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                }
              />
            </List.Item>
          )}
        />
      </Card>
    </Card>
  );
};

export default OTA;
