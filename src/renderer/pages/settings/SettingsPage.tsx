import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, Form, Input, InputNumber, Button, message, Divider } from "antd";
import { SaveOutlined } from "@ant-design/icons";

export function SettingsPage() {
  const qc = useQueryClient();
  const [form] = Form.useForm();

  const { data } = useQuery({
    queryKey: ["settings"],
    queryFn: () => window.api.invoke("system:getConfig") as Promise<{
      success: boolean; data?: { schedule: { minDelaySeconds: number; maxPerBatch: number } };
    }>,
  });

  const saveMut = useMutation({
    mutationFn: (input: unknown) => window.api.invoke("system:updateConfig", input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      message.success("配置已保存");
    },
  });

  const config = data?.success ? data.data : null;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <Card title="发送设置" className="bg-zinc-900 border-zinc-800">
        <Form form={form} layout="vertical"
          initialValues={config?.schedule || { minDelaySeconds: 30, maxPerBatch: 50 }}
          onFinish={(values) => saveMut.mutateAsync({ schedule: values })}
        >
          <Form.Item name="minDelaySeconds" label="最小发送间隔（秒）"
            rules={[{ required: true }]}>
            <InputNumber min={5} max={300} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="maxPerBatch" label="每批最大发送数量"
            rules={[{ required: true }]}>
            <InputNumber min={1} max={200} style={{ width: "100%" }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" icon={<SaveOutlined />}
            loading={saveMut.isPending}>
            保存
          </Button>
        </Form>
      </Card>

      <Card title="系统信息" className="bg-zinc-900 border-zinc-800">
        <div className="text-sm text-zinc-400 space-y-2">
          <div>版本: Prospector 4.0.0</div>
          <div>技术栈: Electron + TypeScript + React + SQLite</div>
          <div>数据库: data/prospector.db</div>
        </div>
      </Card>
    </div>
  );
}
