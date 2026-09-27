<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useSiteStore } from '../stores/siteStore';
import { useSessionStore } from '../stores/sessionStore';
import { useRingStore } from '../stores/ringStore';
import { useMeasureStore } from '../stores/measureStore';
import { distanceKm } from '../utils/geo';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>();

const siteStore = useSiteStore();
const sessionStore = useSessionStore();
const ringStore = useRingStore();
const measureStore = useMeasureStore();

const keepId = ref('');
const sourceId = ref('');
const submitting = ref(false);

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

const keep = computed(() => siteStore.sites.find((site) => site.id === keepId.value));
const source = computed(() => siteStore.sites.find((site) => site.id === sourceId.value));

/** 两侧下拉互斥：已选为保留点的不能再选作待并点，反之亦然 */
const keepOptions = computed(() => siteStore.sites.filter((site) => site.id !== sourceId.value));
const sourceOptions = computed(() => siteStore.sites.filter((site) => site.id !== keepId.value));

const movingSessions = computed(() =>
  sourceId.value ? sessionStore.sessions.filter((session) => session.siteId === sourceId.value) : [],
);
const openSessions = computed(() => movingSessions.value.filter((session) => !session.closed));
const movingRings = computed(() =>
  sourceId.value ? ringStore.rings.filter((record) => record.siteId === sourceId.value) : [],
);
const morphCount = computed(() => {
  const ringIds = new Set(movingRings.value.map((record) => record.id));
  return measureStore.morphs.filter((morph) => ringIds.has(morph.ringId)).length;
});

const distance = computed(() => (keep.value && source.value ? distanceKm(keep.value, source.value) : 0));
/** 待并点存在进行中的批次时拦截并档 */
const blocked = computed(() => openSessions.value.length > 0);
const ready = computed(() => Boolean(keep.value && source.value));
const canSubmit = computed(() => ready.value && !blocked.value && !submitting.value);

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      keepId.value = '';
      sourceId.value = '';
      submitting.value = false;
    }
  },
);

async function submit() {
  if (!canSubmit.value || !keep.value || !source.value) return;
  submitting.value = true;
  const keepName = keep.value.name;
  const sourceName = source.value.name;
  const morphs = morphCount.value;
  try {
    const result = await siteStore.mergeSites(keepId.value, sourceId.value);
    ElMessage.success(
      `并档完成：${result.sessions} 个批次、${result.rings} 条环志（关联量度 ${morphs} 条）已迁入「${keepName}」，` +
        `原鸟点「${sourceName}」的名称与坐标已留痕`,
    );
    visible.value = false;
  } catch (error) {
    ElMessage.error(`并档失败：${(error as Error).message}。两边档案均未改动`);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="鸟点并档" width="640px">
    <p class="merge-desc">
      同一地点被重复登记为两个鸟点时，可将待并点的批次与环志记录迁入保留点；迁入记录保留原鸟点名称与坐标快照，待并点随后从台账移除。
    </p>

    <el-form label-width="90px">
      <el-form-item label="保留点">
        <el-select v-model="keepId" placeholder="并档后保留的鸟点" style="width: 100%">
          <el-option v-for="site in keepOptions" :key="site.id" :label="`${site.siteNo} · ${site.name}`" :value="site.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="待并点">
        <el-select v-model="sourceId" placeholder="将被并入并移除的鸟点" style="width: 100%">
          <el-option v-for="site in sourceOptions" :key="site.id" :label="`${site.siteNo} · ${site.name}`" :value="site.id" />
        </el-select>
      </el-form-item>
    </el-form>

    <template v-if="ready && keep && source">
      <el-divider content-position="left">迁移清单</el-divider>
      <div class="merge-summary">
        <el-tag effect="plain">批次 {{ movingSessions.length }} 个</el-tag>
        <el-tag effect="plain" type="success">环志 {{ movingRings.length }} 条</el-tag>
        <el-tag effect="plain" type="warning">量度 {{ morphCount }} 条</el-tag>
        <span class="merge-distance">两点相距 {{ distance }} km</span>
      </div>

      <el-table v-if="movingSessions.length > 0" :data="movingSessions" size="small" border max-height="180" class="merge-table">
        <el-table-column prop="sessionNo" label="批次号" width="110" />
        <el-table-column prop="date" label="日期" width="110" />
        <el-table-column prop="leader" label="主调查人" width="100" />
        <el-table-column label="状态" width="90">
          <template #default="scope">
            <el-tag :type="scope.row.closed ? 'success' : 'warning'" size="small">
              {{ scope.row.closed ? '已关闭' : '进行中' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" show-overflow-tooltip />
      </el-table>
      <p v-else class="merge-empty">待并点名下没有调查批次</p>

      <el-alert
        v-if="blocked"
        type="error"
        show-icon
        :closable="false"
        class="merge-alert"
        :title="`待并点还有 ${openSessions.length} 个进行中的批次（${openSessions.map((s) => s.sessionNo).join('、')}）`"
        description="请先关闭这些批次再并档，避免进行中的数据被改动。"
      />
      <el-alert
        v-else
        type="info"
        show-icon
        :closable="false"
        class="merge-alert"
        :title="`确认后：上述记录归入「${keep.name}」，并保留原鸟点「${source.name}」（${source.lng}°E, ${source.lat}°N）的名称与坐标快照`"
        description="快照作为历史留痕，之后调整保留点位置也不会改写；待并点将从台账移除。并档在单个事务中完成，中途失败两边档案都不变。"
      />
    </template>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :disabled="!canSubmit" :loading="submitting" @click="submit">确认并档</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.merge-desc {
  margin: 0 0 12px;
  color: #6f8480;
  font-size: 13px;
}
.merge-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.merge-distance {
  font-size: 12px;
  color: #8a99a5;
}
.merge-table {
  margin-bottom: 10px;
}
.merge-empty {
  margin: 0 0 10px;
  font-size: 13px;
  color: #8a99a5;
}
.merge-alert {
  margin-top: 4px;
}
</style>
