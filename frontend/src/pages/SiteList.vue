<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import SiteMap from '../components/common/SiteMap.vue';
import FilterBar from '../components/common/FilterBar.vue';
import EmptyPanel from '../components/common/EmptyPanel.vue';
import { useSiteFilter } from '../hooks/useSiteFilter';
import { useSiteStore } from '../stores/siteStore';
import { useAmap } from '../hooks/useAmap';
import { useSessionStore } from '../stores/sessionStore';
import { useRingStore } from '../stores/ringStore';
import { HABITATS, type BirdSite, type Habitat } from '../types/bird-site';
import { distanceKm, habitatColor } from '../utils/geo';
import { mergeSites, previewMergeSites, type MergePreview } from '../utils/mergeSites';

const siteStore = useSiteStore();
const sessionStore = useSessionStore();
const ringStore = useRingStore();
const amap = useAmap();
const filter = useSiteFilter();

const dialogVisible = ref(false);
const editingId = ref('');
const selectedId = ref('');
const formRef = ref<FormInstance>();

interface SiteForm {
  siteNo: string;
  name: string;
  lng: number;
  lat: number;
  habitat: Habitat;
  netCount: number;
  note: string;
}

const form = ref<SiteForm>({
  siteNo: '',
  name: '',
  lng: 118.05,
  lat: 38.92,
  habitat: '芦苇湿地',
  netCount: 8,
  note: '',
});

const rules: FormRules = {
  siteNo: [{ required: true, message: '请输入点位编号', trigger: 'blur' }],
  name: [{ required: true, message: '请输入点位名称', trigger: 'blur' }],
};

const visible = computed(() => filter.apply(siteStore.sites, sessionStore.sessions));
const selected = computed(() => siteStore.sites.find((site) => site.id === selectedId.value));

/** 与已有点位的最小间距（km），用于提示点位过近 */
const nearest = computed(() => {
  if (!selected.value) return undefined;
  const others = siteStore.sites.filter((site) => site.id !== selected.value?.id);
  if (others.length === 0) return undefined;
  return others
    .map((site) => ({ site, km: distanceKm(site, selected.value!) }))
    .sort((a, b) => a.km - b.km)[0];
});

function openCreate() {
  editingId.value = '';
  formRef.value?.clearValidate();
  form.value = {
    siteNo: `S-${String(siteStore.sites.length + 1).padStart(2, '0')}`,
    name: '',
    lng: 118.05,
    lat: 38.92,
    habitat: '芦苇湿地',
    netCount: 8,
    note: '',
  };
  dialogVisible.value = true;
}

function openEdit(site: BirdSite) {
  editingId.value = site.id;
  form.value = {
    siteNo: site.siteNo,
    name: site.name,
    lng: site.lng,
    lat: site.lat,
    habitat: site.habitat,
    netCount: site.netCount,
    note: site.note ?? '',
  };
  dialogVisible.value = true;
}

/** 地图 / 网格拾取坐标 → 回填表单 */
function handlePick(point: { lng: number; lat: number }) {
  form.value.lng = point.lng;
  form.value.lat = point.lat;
  ElMessage.success(`已拾取坐标 ${point.lng}°E, ${point.lat}°N`);
}

async function submit() {
  const ok = await formRef.value?.validate().catch(() => false);
  if (!ok) return;
  const payload = {
    siteNo: form.value.siteNo,
    name: form.value.name,
    lng: Number(form.value.lng) || 0,
    lat: Number(form.value.lat) || 0,
    habitat: form.value.habitat,
    netCount: Number(form.value.netCount) || 0,
    note: form.value.note,
  };
  if (editingId.value) {
    await siteStore.updateSite(editingId.value, payload);
    ElMessage.success(`已更新鸟点 ${payload.siteNo}`);
  } else {
    const created = await siteStore.addSite(payload);
    selectedId.value = created.id;
    ElMessage.success(`已登记鸟点 ${payload.siteNo} · ${payload.name}（${payload.habitat}）`);
  }
  dialogVisible.value = false;
}

async function remove(site: BirdSite) {
  const confirmed = await ElMessageBox.confirm(`确认删除鸟点 ${site.siteNo} · ${site.name}？`, '删除确认', { type: 'warning' })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await siteStore.removeSite(site.id);
  ElMessage.success('已删除');
}

/* ---------- 鸟点并档 ---------- */

const mergeVisible = ref(false);
const mergeKeepId = ref('');
const mergeSourceId = ref('');
const mergeLoading = ref(false);
const mergeSubmitting = ref(false);
const mergePreview = ref<MergePreview | null>(null);
const mergeError = ref('');

/** 待并点选项：排除保留点，避免选成同一个鸟点 */
const mergeSourceOptions = computed(() =>
  siteStore.sites.filter((site) => site.id !== mergeKeepId.value).map((site) => ({ label: `${site.siteNo} · ${site.name}`, value: site.id })),
);
const mergeKeepOptions = computed(() =>
  siteStore.sites.filter((site) => site.id !== mergeSourceId.value).map((site) => ({ label: `${site.siteNo} · ${site.name}`, value: site.id })),
);
const canMerge = computed(() => Boolean(mergePreview.value) && !mergePreview.value!.blocked && !mergeLoading.value && !mergeSubmitting.value);

/** 打开并档弹窗；从台账行点入时把该行预填为待并点 */
function openMerge(sourceId = '') {
  mergeSourceId.value = sourceId;
  mergeKeepId.value = siteStore.sites.find((site) => site.id !== sourceId)?.id ?? '';
  mergePreview.value = null;
  mergeError.value = '';
  mergeVisible.value = true;
}

// 保留点 / 待并点变更后即时刷新迁移清单
watch([mergeVisible, mergeKeepId, mergeSourceId], async ([visible, keepId, sourceId]) => {
  if (!visible || !keepId || !sourceId || keepId === sourceId) {
    mergePreview.value = null;
    mergeError.value = '';
    return;
  }
  mergeLoading.value = true;
  mergeError.value = '';
  try {
    mergePreview.value = await previewMergeSites(keepId as string, sourceId as string);
  } catch (error) {
    mergePreview.value = null;
    mergeError.value = (error as Error).message;
  } finally {
    mergeLoading.value = false;
  }
});

async function confirmMerge() {
  const preview = mergePreview.value;
  if (!preview || preview.blocked) return;
  const confirmed = await ElMessageBox.confirm(
    `确认将「${preview.source.siteNo} · ${preview.source.name}」并入「${preview.keep.siteNo} · ${preview.keep.name}」？` +
      `将迁移 ${preview.sessions.length} 个批次、${preview.rings.length} 条环志、${preview.morphs.length} 条量度，` +
      '迁入记录会保留原鸟点名称与坐标，操作不可撤销。',
    '并档确认',
    { type: 'warning', confirmButtonText: '确认并档', cancelButtonText: '再想想' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;

  mergeSubmitting.value = true;
  try {
    const result = await mergeSites(mergeKeepId.value, mergeSourceId.value);
    // 事务成功提交后再同步内存状态；失败时本函数直接进 catch，两边档案都不变
    await Promise.all([siteStore.hydrate(), sessionStore.hydrate(), ringStore.hydrate()]);
    if (selectedId.value === mergeSourceId.value) selectedId.value = mergeKeepId.value;
    mergeVisible.value = false;
    ElMessage.success(
      `并档完成：迁入 ${result.sessionCount} 个批次、${result.ringCount} 条环志、${result.morphCount} 条量度，原鸟点已删除`,
    );
  } catch (error) {
    ElMessage.error(`并档失败，两边档案均未改动：${(error as Error).message}`);
    mergeError.value = (error as Error).message;
  } finally {
    mergeSubmitting.value = false;
  }
}
</script>

<template>
  <div>
    <h2 class="page-title">鸟点台账与地图定位</h2>
    <p class="page-desc">
      地图与 SVG 网格双模式：配置 VITE_AMAP_KEY 时使用高德 JS API，未配置时自动退化为本地 SVG 网格视图；表单拾取坐标即在地图 / 网格上落点。
    </p>

    <div class="toolbar">
      <el-button type="primary" @click="openCreate">登记鸟点</el-button>
      <el-button :disabled="siteStore.sites.length < 2" @click="openMerge()">鸟点并档</el-button>
      <el-tag :type="amap.keyPresent ? 'success' : 'info'" effect="plain">
        高德 key：{{ amap.keyPresent ? '已配置' : '未配置（网格模式）' }}
      </el-tag>
      <el-tag type="info" effect="plain">点位 {{ siteStore.sites.length }} 个 · 网位合计 {{ siteStore.totalNets }}</el-tag>
    </div>

    <FilterBar
      :fields="[
        { key: 'habitat', label: '生境', options: HABITATS, width: 120 },
        { key: 'session', label: '作业时段', options: sessionStore.sessions.map((s) => s.sessionNo), width: 130 },
      ]"
      keyword-placeholder="搜索点位编号 / 名称 / 备注"
      :result-count="visible.length"
      :total-count="siteStore.sites.length"
    />

    <EmptyPanel v-if="visible.length === 0" description="没有符合条件的鸟点" action-text="重置筛选条件" @action="filter.reset()" />

    <el-row v-else :gutter="16">
      <el-col :xs="24" :lg="14">
        <el-card shadow="never" class="block">
          <template #header>
            <div class="card-head">
              <span>鸟点分布（{{ visible.length }} 个）</span>
              <span v-if="selected" class="card-note">
                已选 {{ selected.siteNo }} · {{ selected.lng }}°E, {{ selected.lat }}°N
                <template v-if="nearest">· 最近点位 {{ nearest.site.siteNo }} 距离 {{ nearest.km }} km</template>
              </span>
            </div>
          </template>
          <SiteMap :sites="visible" :selected-id="selectedId" :height="420" @select="(id: string) => (selectedId = id)" />
        </el-card>
      </el-col>
      <el-col :xs="24" :lg="10">
        <el-card shadow="never" class="block">
          <template #header>鸟点台账</template>
          <el-table :data="visible" size="small" border @row-click="(row: BirdSite) => (selectedId = row.id)">
            <el-table-column prop="siteNo" label="编号" width="80" />
            <el-table-column prop="name" label="名称" min-width="120" />
            <el-table-column label="生境" width="110">
              <template #default="scope">
                <el-tag size="small" effect="plain" :style="{ borderColor: habitatColor(scope.row.habitat as Habitat), color: habitatColor(scope.row.habitat as Habitat) }">
                  {{ scope.row.habitat }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="坐标" width="170">
              <template #default="scope">{{ scope.row.lng }}°E, {{ scope.row.lat }}°N</template>
            </el-table-column>
            <el-table-column prop="netCount" label="网位" width="70" align="right" />
            <el-table-column prop="note" label="备注" show-overflow-tooltip />
            <el-table-column label="操作" width="170" fixed="right">
              <template #default="scope">
                <el-button link type="primary" @click.stop="openEdit(scope.row)">编辑</el-button>
                <el-button link type="warning" @click.stop="openMerge(scope.row.id)">并档</el-button>
                <el-button link type="danger" @click.stop="remove(scope.row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑鸟点' : '登记鸟点'" width="860px">
      <el-row :gutter="16">
        <el-col :xs="24" :md="11">
          <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
            <el-form-item label="点位编号" prop="siteNo">
              <el-input v-model="form.siteNo" placeholder="如：S-07" maxlength="12" />
            </el-form-item>
            <el-form-item label="点位名称" prop="name">
              <el-input v-model="form.name" placeholder="如：大汶流芦苇荡" maxlength="30" />
            </el-form-item>
            <el-form-item label="经度(°E)">
              <el-input-number v-model="form.lng" :min="117.4" :max="118.4" :step="0.001" :precision="3" placeholder="经度" style="width: 100%" />
            </el-form-item>
            <el-form-item label="纬度(°N)">
              <el-input-number v-model="form.lat" :min="38.6" :max="39.4" :step="0.001" :precision="3" placeholder="纬度" style="width: 100%" />
            </el-form-item>
            <el-form-item label="生境">
              <el-select v-model="form.habitat" style="width: 100%">
                <el-option v-for="habitat in HABITATS" :key="habitat" :label="habitat" :value="habitat" />
              </el-select>
            </el-form-item>
            <el-form-item label="网位数">
              <el-input-number v-model="form.netCount" :min="0" :max="60" placeholder="网位数" style="width: 100%" />
            </el-form-item>
            <el-form-item label="备注">
              <el-input v-model="form.note" type="textarea" :rows="2" maxlength="60" placeholder="网阵布置、注意事项等" />
            </el-form-item>
          </el-form>
        </el-col>
        <el-col :xs="24" :md="13">
          <div class="pick-title">点击地图 / 网格拾取坐标（当前 {{ form.lng }}°E, {{ form.lat }}°N）</div>
          <SiteMap :sites="siteStore.sites" :selected-id="editingId" :height="300" pickable @pick="handlePick" />
        </el-col>
      </el-row>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="mergeVisible" title="鸟点并档" width="640px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="同一片滩涂被录成两个鸟点时，并档把待并点名下的批次、环志与量度归入保留点，随后删除待并点。"
        description="迁入记录会固化原鸟点名称与坐标快照，以后调整保留点位置也不改这些历史记录。"
        class="merge-alert"
      />

      <el-form label-width="92px" class="merge-form">
        <el-form-item label="保留点">
          <el-select v-model="mergeKeepId" placeholder="选择保留下来的鸟点" style="width: 100%">
            <el-option v-for="site in mergeKeepOptions" :key="site.value" :label="site.label" :value="site.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="待并点">
          <el-select v-model="mergeSourceId" placeholder="选择要并入并删除的鸟点" style="width: 100%">
            <el-option v-for="site in mergeSourceOptions" :key="site.value" :label="site.label" :value="site.value" />
          </el-select>
        </el-form-item>
      </el-form>

      <div v-loading="mergeLoading" class="merge-body">
        <el-alert v-if="mergeError" type="error" :closable="false" show-icon :title="mergeError" class="merge-alert" />
        <template v-else-if="mergePreview">
          <el-alert
            v-if="mergePreview.blocked"
            type="error"
            :closable="false"
            show-icon
            title="待并点还有进行中的批次，请先关闭这些批次后再并档"
            class="merge-alert"
          >
            <div v-for="session in mergePreview.openSessions" :key="session.id">
              · {{ session.sessionNo }}（{{ session.date }}，主调查人 {{ session.leader }}）
            </div>
          </el-alert>

          <el-descriptions :column="3" border size="small" class="merge-counts">
            <el-descriptions-item label="迁移批次">{{ mergePreview.sessions.length }} 个</el-descriptions-item>
            <el-descriptions-item label="迁移环志">{{ mergePreview.rings.length }} 条</el-descriptions-item>
            <el-descriptions-item label="迁移量度">{{ mergePreview.morphs.length }} 条</el-descriptions-item>
          </el-descriptions>

          <div v-if="mergePreview.sessions.length" class="merge-list-title">涉及批次：</div>
          <div v-if="mergePreview.sessions.length" class="merge-sessions">
            <el-tag
              v-for="session in mergePreview.sessions"
              :key="session.id"
              :type="session.closed ? 'success' : 'warning'"
              size="small"
              effect="plain"
            >
              {{ session.sessionNo }} · {{ session.date }} · {{ session.closed ? '已关闭' : '进行中' }}
            </el-tag>
          </div>

          <div class="merge-snapshot">
            历史快照：迁入记录将标注原鸟点 {{ mergePreview.source.siteNo }} · {{ mergePreview.source.name }}
            （{{ mergePreview.source.lng }}°E, {{ mergePreview.source.lat }}°N）
          </div>
        </template>
        <el-empty v-else-if="!mergeLoading" description="请选择保留点与待并点" :image-size="64" />
      </div>

      <template #footer>
        <el-button @click="mergeVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!canMerge" :loading="mergeSubmitting" @click="confirmMerge">确认并档</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-title {
  margin: 0 0 4px;
  font-size: 20px;
  color: #1f4a44;
}
.page-desc {
  margin: 0 0 12px;
  color: #6f8480;
  font-size: 13px;
}
.toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.block {
  margin-bottom: 16px;
  border-radius: 8px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.card-note {
  font-size: 12px;
  color: #8a99a5;
}
.pick-title {
  font-size: 13px;
  color: #2f4a44;
  margin-bottom: 6px;
}
.merge-alert {
  margin-bottom: 12px;
}
.merge-form {
  margin-top: 4px;
}
.merge-body {
  min-height: 120px;
}
.merge-counts {
  margin-bottom: 10px;
}
.merge-list-title {
  font-size: 13px;
  color: #2f4a44;
  margin-bottom: 6px;
}
.merge-sessions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.merge-snapshot {
  font-size: 12px;
  color: #8a99a5;
  line-height: 1.6;
}
</style>
