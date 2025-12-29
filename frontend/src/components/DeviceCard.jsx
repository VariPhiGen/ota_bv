import React from "react";
import { Card, Tag, Space, Typography } from "antd";

const { Text } = Typography;

const statusMap = {
  true: { color: "green", label: "Online" },
  false: { color: "red", label: "Offline" },
};

const DeviceCard = ({ device }) => {
  const status = statusMap[device.online ? "true" : "false"] || { color: "default", label: "Unknown" };
  return (
    <Card
      title={device.device_name || device.sensor_name || device.sensor_id || device.device_id || "Device"}
      size="small"
      extra={<Tag color={status.color}>{status.label}</Tag>}
      style={{ width: "100%" }}
    >
      <Space direction="vertical" size={4}>
        {device.sensor_id && <Text type="secondary">Sensor ID: {device.sensor_id}</Text>}
        {device.device_id && <Text type="secondary">Device ID: {device.device_id}</Text>}
        {device.sensor_name && <Text type="secondary">Sensor Name: {device.sensor_name}</Text>}
        {device.client_name && <Text type="secondary">Client: {device.client_name}</Text>}
        {device.last_seen && <Text type="secondary">Last seen: {device.last_seen}</Text>}
      </Space>
    </Card>
  );
};

export default DeviceCard;
