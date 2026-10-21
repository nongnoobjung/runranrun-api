import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { prepareImage } from '../src/common/images';
import { FileStorage } from '../src/common/storage';
import { eventImageUrl, insertEventImage } from '../src/modules/org/org-event-images.service';

const image = (name: string) => readFileSync(join(__dirname, 'images', name));

const DESCRIPTION_TH = (startUrl: string) => `## วิ่งเลียบเจ้าพระยายามค่ำคืน

Riverside Night Run กลับมาอีกครั้ง เส้นทาง**ปิดถนนตลอดสาย** เลียบแม่น้ำเจ้าพระยาจากลานริมน้ำบางคอแหลม
ลอดใต้สะพานพระราม 3 แล้ววนกลับเข้าเส้นชัยริมน้ำ อากาศเย็น ไฟเมืองสวย เหมาะกับทั้งมือใหม่และคนล่าเวลา

![จุดปล่อยตัวริมแม่น้ำ](${startUrl})

### สิ่งที่ได้รับ

- เสื้อวิ่ง Dry-fit
- เหรียญที่ระลึกสำหรับผู้เข้าเส้นชัยทุกระยะ
- น้ำดื่มและเกลือแร่ทุก 2 กม.
- ประกันอุบัติเหตุตลอดการแข่งขัน

### ตารางเวลาวันงาน

1. 16:30 เปิดจุดรับฝากของ
2. 18:30 ปล่อยตัว 21K
3. 19:00 ปล่อยตัว 10K และ 5K
4. 21:30 ปิดเส้นทาง

_รับเสื้อและบิบล่วงหน้าได้ที่ลานริมน้ำ 2 วันก่อนงาน_ ดูการเดินทางได้ที่ [riverside.example](https://riverside.example/travel)`;

const DESCRIPTION_EN = (startUrl: string) => `## A night run along the Chao Phraya

Riverside Night Run is back on a **fully closed road** along the Chao Phraya River, from the Bang Kho Laem riverside
under the Rama III Bridge and back to a finish line by the water. Cool air and city lights, for first-timers and
PB hunters alike.

![Start line by the river](${startUrl})

### What you get

- Dry-fit running shirt
- Finisher medal for every distance
- Water and electrolytes every 2 km
- Accident insurance for the whole race

### Race-day schedule

1. 16:30 Bag drop opens
2. 18:30 21K start
3. 19:00 10K and 5K start
4. 21:30 Course closes

_Shirt and bib pick-up opens at the riverside two days before the race._ Getting there: [riverside.example](https://riverside.example/travel)`;

const RULES_TH = `- ติดบิบไว้ด้านหน้าให้มองเห็นตลอดการแข่งขัน
- ห้ามใช้หูฟังแบบปิดหูทั้งสองข้าง
- ผ่านจุด cut-off ไม่ทันเวลาต้องขึ้นรถเก็บตัว`;

const RULES_EN = `- Wear your bib on the front, visible for the whole race
- No headphones covering both ears
- Runners who miss a cut-off board the sweep bus`;

/**
 * Gives the seeded Riverside event a real page: Thai and English Markdown, rules, a cover and a gallery. Runs once;
 * an event that already has a Thai description is left alone.
 */
export async function seedRiversideContent(pool: Pool, storage: FileStorage, eventId: string): Promise<boolean> {
  const current = await pool.query<{ description_th: string | null }>('SELECT description_th FROM events WHERE id = $1', [eventId]);
  if (current.rows[0]?.description_th) return false;
  const client = await pool.connect();
  const keys: string[] = [];
  try {
    await client.query('BEGIN');
    const add = async (name: string) => {
      const img = await insertEventImage(client, storage, { eventId, userId: null, image: await prepareImage(image(name)) });
      keys.push(img.key);
      return img;
    };
    const cover = await add('riverside-cover.jpg');
    const start = await add('riverside-start.jpg');
    const medal = await add('riverside-medal.jpg');
    await client.query(
      `UPDATE events SET summary_en = $2, description_th = $3, description_en = $4, rules_th = $5, rules_en = $6,
              cover_image_url = $7, gallery = $8 WHERE id = $1`,
      [
        eventId, 'A closed-road night run along the Chao Phraya River', DESCRIPTION_TH(eventImageUrl(start.id)),
        DESCRIPTION_EN(eventImageUrl(start.id)), RULES_TH, RULES_EN, cover.url,
        JSON.stringify([
          { imageId: start.id, captionTh: 'จุดปล่อยตัวริมแม่น้ำ', captionEn: 'The start by the river' },
          { imageId: medal.id, captionTh: 'เหรียญ 21.1 กม.', captionEn: 'The 21.1 km medal' },
        ]),
      ],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    await Promise.all(keys.map((k) => storage.delete(k)));
    throw err;
  } finally {
    client.release();
  }
}
