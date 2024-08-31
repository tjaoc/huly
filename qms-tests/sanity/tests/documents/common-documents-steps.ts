import { Page, test } from '@playwright/test'
import { LeftSideMenuPage } from '../model/left-side-menu-page'
import { DocumentsPage } from '../model/documents/documents-page'
import { NewCategory, NewDocument } from '../model/types'
import { NavigationMenuPage } from '../model/documents/navigation-menu-page'
import { CategoriesPage } from '../model/documents/categories-page'
import { CategoryCreatePopup } from '../model/documents/category-create-popup'

export async function prepareDocumentStep (page: Page, document: NewDocument, stepNumber: number = 1): Promise<void> {
  await test.step(`${stepNumber}. Create a new document`, async () => {
    const leftSideMenuPage = new LeftSideMenuPage(page)
    await leftSideMenuPage.buttonDocuments.click()

    const documentsPage = new DocumentsPage(page)
    await documentsPage.buttonCreateDocument.click()

    await documentsPage.createDocument(document)
  })
}

export async function createTemplateStep (
  page: Page,
  title: string,
  description: string,
  category: string
): Promise<void> {
  await test.step('2. Create a new template', async () => {
    const documentsPage = new DocumentsPage(page)

    await documentsPage.createTemplate(title, description, category)
  })
}

export async function prepareCategoryStep (page: Page, newCategory: NewCategory): Promise<void> {
  await test.step('1. Create a new category', async () => {
    const leftSideMenuPage = new LeftSideMenuPage(page)
    await leftSideMenuPage.buttonDocuments.click()

    const navigationMenuPage = new NavigationMenuPage(page)
    await navigationMenuPage.buttonCategories.click()

    const categoriesPage = new CategoriesPage(page)
    await categoriesPage.buttonCreateCategory.click()

    const categoryCreatePopup = new CategoryCreatePopup(page)
    await categoryCreatePopup.createCategory(newCategory)
  })
}
