import React, { useState, useEffect } from "react";
import styles from "./Emotion.module.scss";
import { EmotionType } from "@common/types/taskGraph";
import { useEmotion } from "@/contexts/AgentContext";
import { Radar } from "react-chartjs-2";
import {
  Chart as ChartJS,
  RadialLinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
  TooltipItem,
} from "chart.js";
import classNames from "classnames";

ChartJS.register(
  RadialLinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend
);

interface EmotionProps {
  isMobile?: boolean;
}

const EMOTION_LABELS = [
  "喜び",
  "信頼",
  "恐れ",
  "驚き",
  "悲しみ",
  "嫌悪",
  "怒り",
  "期待",
];

const EMOTION_GROUPS = {
  positive: { r: 74, g: 222, b: 128 },
  negative: { r: 96, g: 165, b: 250 },
  anger: { r: 248, g: 113, b: 113 },
  surprise: { r: 251, g: 191, b: 36 },
};

interface EmotionSnapshot {
  time: string;
  label: string;
  joy: number;
  anger: number;
  sadness: number;
}

const MAX_HISTORY = 20;

const Emotion: React.FC<EmotionProps> = ({ isMobile }) => {
  const emotion = useEmotion();
  const [emotionState, setEmotionState] = useState<EmotionType | null>(null);
  const [animatedValues, setAnimatedValues] = useState<number[]>(
    Array(8).fill(50)
  );
  const [history, setHistory] = useState<EmotionSnapshot[]>([]);

  const calculateColor = (values: number[]) => {
    const positive = (values[0] + values[1]) / 200;
    const negative = (values[2] + values[4] + values[5]) / 300;
    const anger = values[6] / 100;
    const surprise = (values[3] + values[7]) / 200;
    const total = positive + negative + anger + surprise || 1;

    const r =
      (EMOTION_GROUPS.positive.r * positive +
        EMOTION_GROUPS.negative.r * negative +
        EMOTION_GROUPS.anger.r * anger +
        EMOTION_GROUPS.surprise.r * surprise) /
      total;
    const g =
      (EMOTION_GROUPS.positive.g * positive +
        EMOTION_GROUPS.negative.g * negative +
        EMOTION_GROUPS.anger.g * anger +
        EMOTION_GROUPS.surprise.g * surprise) /
      total;
    const b =
      (EMOTION_GROUPS.positive.b * positive +
        EMOTION_GROUPS.negative.b * negative +
        EMOTION_GROUPS.anger.b * anger +
        EMOTION_GROUPS.surprise.b * surprise) /
      total;

    return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
  };

  useEffect(() => {
    if (emotion) {
      const unsubscribe = emotion.onUpdateEmotion((e) => {
        setEmotionState(e);
        const now = new Date();
        const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
        setHistory(prev => [
          ...prev.slice(-(MAX_HISTORY - 1)),
          {
            time: timeStr,
            label: e.emotion || '',
            joy: e.parameters.joy,
            anger: e.parameters.anger,
            sadness: e.parameters.sadness,
          },
        ]);
      });
      return () => { unsubscribe(); };
    }
  }, [emotion]);

  useEffect(() => {
    const newValues = emotionState
      ? [
          emotionState.parameters.joy,
          emotionState.parameters.trust,
          emotionState.parameters.fear,
          emotionState.parameters.surprise,
          emotionState.parameters.sadness,
          emotionState.parameters.disgust,
          emotionState.parameters.anger,
          emotionState.parameters.anticipation,
        ]
      : Array(8).fill(50);
    setAnimatedValues(newValues);
  }, [emotionState]);

  const color = calculateColor(animatedValues);
  const colorStr = `${color.r}, ${color.g}, ${color.b}`;

  // ラベルに現在の値を付与（例: "喜び 30"）
  const labelsWithValues = EMOTION_LABELS.map((label, i) => `${label} ${Math.round(animatedValues[i])}`);

  const chartData = {
    labels: labelsWithValues,
    datasets: [
      {
        label: "感情パラメータ",
        data: animatedValues,
        backgroundColor: `rgba(${colorStr}, 0.12)`,
        borderColor: `rgba(${colorStr}, 0.8)`,
        borderWidth: 2,
        pointBackgroundColor: `rgba(${colorStr}, 1)`,
        pointBorderColor: "transparent",
        pointRadius: 3,
        pointHoverRadius: 5,
      },
    ],
  };

  const cs = getComputedStyle(document.documentElement);
  const gridColor = cs.getPropertyValue('--chart-grid').trim() || 'rgba(255,255,255,0.06)';
  const labelColor = cs.getPropertyValue('--chart-label').trim() || 'rgba(255,255,255,0.6)';
  const tickColor = cs.getPropertyValue('--chart-tick').trim() || 'rgba(255,255,255,0.2)';

  const chartOptions = {
    scales: {
      r: {
        min: 0,
        max: 100,
        beginAtZero: true,
        ticks: {
          stepSize: 20,
          backdropColor: "transparent",
          color: tickColor,
          display: true,
          showLabelBackdrop: false,
          font: { size: 9 },
        },
        grid: {
          color: gridColor,
        },
        angleLines: {
          color: gridColor,
        },
        pointLabels: {
          color: labelColor,
          font: { size: 10, weight: "500" as const },
          padding: 14,
        },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        displayColors: false,
        backgroundColor: "rgba(0, 0, 0, 0.8)",
        titleFont: { size: 11 },
        bodyFont: { size: 12 },
        padding: 8,
        cornerRadius: 6,
        callbacks: {
          label: (context: TooltipItem<"radar">) =>
            `${Math.round(context.raw as number)}`,
        },
      },
    },
    animation: {
      duration: 2000,
      easing: "linear" as const,
    },
    maintainAspectRatio: false,
  };

  return (
    <div className={classNames(styles.card, { [styles.mobile]: isMobile })}>
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle}>Emotion</span>
        {emotionState?.emotion && (
          <span
            className={styles.emotionBadge}
            style={{
              backgroundColor: `rgba(${colorStr}, 0.15)`,
              color: `rgb(${colorStr})`,
              transition: 'all 0.5s ease',
            }}
          >
            {emotionState.emotion}
          </span>
        )}
      </div>

      <div className={styles.chartWrapper}>
        <Radar data={chartData} options={chartOptions} />
      </div>

      {history.length > 1 && (
        <div className={styles.timeline}>
          <div className={styles.timelineLabel}>感情履歴</div>
          <div className={styles.timelineBars}>
            {history.map((h, i) => (
              <div
                key={i}
                className={styles.timelineBar}
                data-tip={`${h.time}${h.label ? ` · ${h.label}` : ''}\n喜:${Math.round(h.joy)} 怒:${Math.round(h.anger)} 悲:${Math.round(h.sadness)}`}
              >
                <div
                  className={styles.barJoy}
                  style={{ height: `${h.joy * 0.3}px` }}
                />
                <div
                  className={styles.barAnger}
                  style={{ height: `${h.anger * 0.3}px` }}
                />
                <div
                  className={styles.barSad}
                  style={{ height: `${h.sadness * 0.3}px` }}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default Emotion;
