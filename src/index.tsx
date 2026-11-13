import { definePlugin } from "@decky/api";
import { ButtonItem, DropdownItem, Field, PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";
import { useEffect, useState, VFC } from "react";
import { QueryClient, QueryClientProvider } from "react-query";
import { SETTINGS } from "./consts";
import { useSetting } from "./hooks/useSetting";
import { cloud } from "./icon";
import { UploadService } from "./service";

const Content: VFC<{ service: UploadService }> = ({ service }) => {
  const [, render] = useState(0);
  const [detailPage, setDetailPage] = useState(0);
  useEffect(() => service.subscribe(() => render(n => n + 1)), [service]);
  const changed = () => { void service.kick(true); };
  const enabled = useSetting(SETTINGS.ENABLED, true, () => { service.settingsSaved(); changed(); });
  const notification = useSetting(SETTINGS.NOTIFICATION_ENABLED, true, changed);
  const privacy = useSetting<number>(SETTINGS.PRIVACY_STATE, 2, changed);
  const status = service.queue.snapshot();
  const failed = status.tasks.filter(task => task.status === "failed");
  const uploading = status.tasks.filter(task => task.status === "uploading").length;
  const waiting = status.tasks.filter(task => task.status !== "failed" && task.status !== "uploading").length;
  const details = failed.length ? failed : status.tasks;
  const lastPage = Math.max(0, Math.ceil(details.length / 5) - 1);
  const page = Math.min(detailPage, lastPage);
  return <>
    <PanelSection title="设置">
      <PanelSectionRow>
        <ToggleField label="自动上传及补传" checked={enabled.value} disabled={enabled.isLoading}
          onChange={value => {
            if (!value) service.pauseImmediately();
            enabled.update(value);
          }} />
        <ToggleField label="完成后通知" checked={notification.value} disabled={notification.isLoading}
          onChange={notification.update} />
        <DropdownItem label="新任务的可见性" menuLabel="可见性"
          description="默认私密。已排队截图保留加入队列时的设置。"
          rgOptions={[{ label: "私密", data: 2 }, { label: "仅好友", data: 4 },
            { label: "公开", data: 8 }, { label: "不列出", data: 16 }]}
          selectedOption={privacy.value} onChange={option => privacy.update(option.data)} />
      </PanelSectionRow>
    </PanelSection>
    <PanelSection title="补传进度">
      <PanelSectionRow>
        <Field label="状态">{!status.account ? "等待 Steam 登录" : !status.enabled ? "已暂停"
          : !status.online ? "离线，联网后继续" : status.busy ? "正在检查或上传" : "就绪"}</Field>
        <Field label="待上传 / 上传中 / 失败">{waiting} / {uploading} / {failed.length}</Field>
        <Field label="本次运行已完成">{status.completed}</Field>
        <ButtonItem disabled={!status.enabled || status.busy} onClick={() => { void service.kick(true); }}>
          立即检查并补传
        </ButtonItem>
        <ButtonItem disabled={!status.enabled || status.busy || !failed.length}
          onClick={() => { void service.kick(true, true); }}>重试失败项</ButtonItem>
        <Field description="启动时和每两分钟检查遗漏；离线时保留任务。暂停后，已经开始的上传会完成。" />
        {(service.error || status.error) && <Field label="需要处理">{service.error || status.error}</Field>}
      </PanelSectionRow>
    </PanelSection>
    {!!details.length && <PanelSection title={failed.length ? "失败详情" : "任务详情"}>
      {details.slice(page * 5, page * 5 + 5).map(task => <PanelSectionRow key={task.id}>
        <Field label={`${task.gameId} · ${task.path.split("/").pop()}`}
          description={task.error || (task.status === "uploading" ? "上传中" : "等待上传")}>
          已尝试 {task.attempts} 次
        </Field>
      </PanelSectionRow>)}
      {lastPage > 0 && <PanelSectionRow>
        <Field label="页码">{page + 1} / {lastPage + 1}</Field>
        <ButtonItem disabled={page === 0} onClick={() => setDetailPage(page - 1)}>上一页</ButtonItem>
        <ButtonItem disabled={page === lastPage} onClick={() => setDetailPage(page + 1)}>下一页</ButtonItem>
      </PanelSectionRow>}
    </PanelSection>}
  </>;
};

export default definePlugin(() => {
  const service = new UploadService();
  const queries = new QueryClient();
  service.start();
  return {
    name: "ScreenshotUploader",
    title: <div>Screenshot Uploader</div>,
    content: <QueryClientProvider client={queries}><Content service={service} /></QueryClientProvider>,
    icon: cloud,
    onDismount() { service.stop(); queries.clear(); },
  };
});
